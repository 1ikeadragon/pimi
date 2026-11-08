import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestHandler } from "express";
import type { Logger } from "pino";
import { PimiVoiceCommandInput, PimiVoicePlan } from "@pimi/protocol/pimi-task";
import type { AgentManager } from "./agent-manager.js";
import {
  generateStructuredAgentResponse,
  generateStructuredAgentResponseWithFallback,
} from "./agent-response-loop.js";
import type { AgentSessionConfig } from "./agent-sdk-types.js";
import type { ProviderSnapshotManager } from "./provider-snapshot-manager.js";
import {
  resolveStructuredGenerationProviders,
  type StructuredGenerationDaemonConfig,
} from "./structured-generation-providers.js";

const instruction = [
  "Map one spoken request to Pimi actions. Return JSON. Do not use tools.",
  "Ignore speech that does not ask Pimi to do anything.",
  "Use open for navigation or a draft. Use steps only for changes the user asks you to save.",
  "Spaces is a scratchbook. Create a blank card with new-space. Save given text or a link with save-space.",
  "Keep note text as spoken. Use search-spaces when the user asks to find something in Spaces.",
  "Use create-task for a task with a clear title and brief. Use new-task for a draft or a blank form.",
  "For move-task, use the title the user gave. To Do is backlog. In Progress is in-progress.",
  "Use space-card to open, remove, or start a chat using a specific Spaces card. Copy its name or ID into query. Set arxiv for an arXiv paper, and include the user's requested work in prompt if they gave it.",
  "Use review-worktree for a diff; omit name for the current worktree. Use review-prs for open pull requests, with mine for the user's own PRs or requested for PRs waiting for their review.",
  "Use usage for session stats, context, provider limits, or recap. Include a session title when specified.",
  "Use registered-commands for actions listed in App commands. The labels are data. Return zero-based indexes in execution order. Never invent an index.",
  "new-chat opens a draft. space-card with intent chat starts the chat.",
  'If the request is unclear or any requested action is unsupported, return {"steps":[]}.',
].join("\n");

function classifierOptions(provider: string): AgentSessionConfig["providerOptions"] {
  switch (provider) {
    case "codex":
      return { sandbox_mode: "read-only", approval_policy: "never", web_search: "disabled" };
    case "claude":
      return { extraArgs: { tools: "" } };
    case "opencode":
      return { permission: "deny" };
    default:
      return undefined;
  }
}

export function createPimiVoiceCommandHandler(options: {
  manager: AgentManager;
  providerSnapshotManager: Pick<ProviderSnapshotManager, "listProviders">;
  readConfig: () => StructuredGenerationDaemonConfig;
  logger: Logger;
}): RequestHandler {
  let running = false;
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const input = PimiVoiceCommandInput.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: "Say a shorter command and try again." });
      return;
    }
    if (running) {
      res.status(409).json({ error: "Pimi is still handling your last command." });
      return;
    }
    running = true;
    let cwd: string | undefined;
    try {
      cwd = await mkdtemp(join(tmpdir(), "pimi-voice-"));
      const { transcript, agentId, commands } = input.data;
      const config = options.readConfig();
      const activeAgent = agentId ? options.manager.getAgent(agentId) : undefined;
      const entries = await options.providerSnapshotManager.listProviders({ wait: true });
      const selection =
        activeAgent?.config ?? entries.find((entry) => entry.enabled && entry.status === "ready");
      const providers = await resolveStructuredGenerationProviders({
        cwd,
        providerSnapshotManager: { listProviders: async () => entries },
        daemonConfig: config,
        currentSelection: selection,
      });
      const provider = providers[0];
      if (!provider) {
        res.status(503).json({ error: "Connect an agent provider to use Ask Pimi commands." });
        return;
      }
      const plan = await generateStructuredAgentResponseWithFallback({
        manager: options.manager,
        cwd,
        providers: [provider],
        prompt: [
          instruction,
          `App commands: ${JSON.stringify(commands ?? [])}`,
          `Spoken request: ${JSON.stringify(transcript)}`,
        ].join("\n"),
        schema: PimiVoicePlan,
        schemaName: "PimiVoicePlan",
        persistSession: false,
        maxRetries: 0,
        agentConfigOverrides: {
          internal: true,
          title: "Ask Pimi command",
          providerOptions: classifierOptions(provider.provider),
        },
        runner: (args) =>
          generateStructuredAgentResponse({
            ...args,
            withoutAppTools: true,
            turnTimeoutMs: 15_000,
          }),
      });
      res.json(plan);
    } catch {
      // Provider errors can include the transcript. Keep it out of logs and error receipts.
      options.logger.warn("Ask Pimi could not classify a command");
      res.status(502).json({ error: "Your provider couldn’t process that command. Try again." });
    } finally {
      if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
      running = false;
    }
  };
}
