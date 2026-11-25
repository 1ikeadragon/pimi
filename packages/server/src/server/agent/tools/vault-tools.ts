import path from "node:path";
import { z } from "zod";
import { VaultSecretNameSchema } from "@pimi/protocol/vault/types";
import { VaultError } from "../../vault/errors.js";
import { RUN_DEFAULT_TIMEOUT_MS, RUN_MAX_TIMEOUT_MS } from "../../vault/runner.js";
import type { VaultService } from "../../vault/service.js";
import type { ManagedAgent } from "../agent-manager.js";
import { AGENT_WAIT_TIMEOUT_MS } from "../mcp-shared.js";
import type { PimiToolHostDependencies } from "./pimi-tools.js";
import {
  PimiToolInputError,
  type PimiToolConfig,
  type PimiToolExecutionContext,
  type PimiToolResult,
} from "./types.js";

export const VAULT_LIST_TOOL = "vault_list";
export const VAULT_RUN_TOOL = "vault_run";

// How long `vault_run` waits for the user to answer an approval request before returning
// "awaiting approval". The same budget the other waiting tools use, because provider SDKs cut a
// tool call off at about 60 s (see AGENT_WAIT_TIMEOUT_MS) and the command still has to run after
// an approval.
const APPROVAL_WAIT_MS = AGENT_WAIT_TIMEOUT_MS;

const MAX_ARGV_LENGTH = 256;
const MAX_SECRETS_PER_RUN = 16;

export const VAULT_INSTRUCTIONS =
  "Credentials are not in your environment. When a command needs one, call vault_list for the names the user stored, then vault_run with the command as an argv array and the secret names it needs. You never see the values; the user approves each new command. Never ask the user to paste a secret into the chat.";

// Terminal output can contain a value the user typed or a program printed. Redacting the joined
// text catches values wrapped across lines; a value that itself spans lines changes the line
// count, so then each line is redacted alone.
export function redactCapturedLines(vault: VaultService | undefined, lines: string[]): string[] {
  if (!vault?.redactionActive) return lines;
  const joined = vault.redact(lines.join("\n")).split("\n");
  return joined.length === lines.length ? joined : lines.map((line) => vault.redact(line));
}

const RunInputSchema = z.strictObject({
  argv: z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_ARGV_LENGTH)
    .describe("The program and its arguments, one array element each. No shell is involved."),
  secrets: z
    .array(VaultSecretNameSchema)
    .min(1)
    .max(MAX_SECRETS_PER_RUN)
    .describe("Names from vault_list to put in the program's environment."),
  cwd: z.string().optional().describe("Working directory. Defaults to this chat's directory."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(RUN_MAX_TIMEOUT_MS)
    .optional()
    .describe(`Kill the program after this long. Default ${RUN_DEFAULT_TIMEOUT_MS} ms.`),
});
type RunInput = z.infer<typeof RunInputSchema>;

function text(value: string): PimiToolResult {
  return { content: [{ type: "text", text: value }] };
}

function toToolError(error: unknown): never {
  if (error instanceof VaultError) {
    const hint =
      error.code === "locked" || error.code === "not_initialized"
        ? " Ask the user to unlock it in Pimi (Settings, Vault)."
        : "";
    throw new PimiToolInputError(`${error.message}${hint}`);
  }
  throw error;
}

export function registerVaultTools(
  options: PimiToolHostDependencies,
  scope: "top-level" | "agent",
  registerTool: <Input>(
    name: string,
    config: PimiToolConfig,
    handler: (input: Input, context: PimiToolExecutionContext) => Promise<PimiToolResult>,
  ) => void,
  resolveCallerAgent: () => ManagedAgent | null,
): void {
  const { vaultService: vault, workspaceRegistry } = options;
  if (scope !== "agent" || !vault) return;
  registerTool(
    VAULT_LIST_TOOL,
    {
      title: "List vault secrets",
      description:
        "List the names and descriptions of secrets the user stored in the Pimi vault, and the commands already approved to use them. Values are never shown.",
      inputSchema: z.strictObject({}),
    },
    async () => {
      try {
        const secrets = vault.listSecrets().map((secret) => ({
          name: secret.name,
          description: secret.description,
        }));
        const approved = vault.listGrants().map((grant) => ({
          command: [grant.executable, ...grant.argvPrefix].join(" "),
          secrets: grant.bindings.map((binding) => binding.secret),
        }));
        return { content: [], structuredContent: { secrets, approved } };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  registerTool(
    VAULT_RUN_TOOL,
    {
      title: "Run a command with vault secrets",
      description:
        "Run one program with stored secrets in its environment and get its output with the secret values removed. The user approves a command the first time; if approval is pending the tool says so and you should call it again with the same arguments. Output is capped and the program is killed on timeout.",
      inputSchema: RunInputSchema,
    },
    async (input: RunInput, context) => {
      try {
        const caller = resolveCallerAgent();
        if (!caller) throw new PimiToolInputError("vault_run needs an agent caller.");
        const workspace = caller.workspaceId
          ? await workspaceRegistry?.get(caller.workspaceId)
          : null;
        const outcome = await vault.run({
          argv: input.argv,
          secrets: input.secrets,
          cwd: path.resolve(caller.config.cwd, input.cwd ?? "."),
          agentId: caller.id,
          projectId: workspace?.projectId ?? null,
          timeoutMs: input.timeoutMs ?? RUN_DEFAULT_TIMEOUT_MS,
          approvalWaitMs: APPROVAL_WAIT_MS,
          signal: context.signal,
        });
        if (outcome.status === "awaiting_approval") {
          return text(
            "Awaiting the user's approval in Pimi (Settings, Vault). Call vault_run again with the same arguments in a moment.",
          );
        }
        if (outcome.status === "denied") {
          return {
            isError: true,
            content: [{ type: "text", text: "The user denied this command." }],
          };
        }
        const { result } = outcome;
        return {
          content: [],
          structuredContent: {
            exitCode: result.exitCode,
            signal: result.signal,
            timedOut: result.timedOut,
            truncated: result.truncated,
            durationMs: result.durationMs,
            stdout: result.stdout,
            stderr: result.stderr,
          },
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );
}
