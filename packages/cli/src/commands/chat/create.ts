import type { Command } from "commander";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import { resolveCallerAgentId } from "../../utils/caller-agent.js";
import type { CommandError, CommandOptions, SingleResult } from "../../output/index.js";
import { toChatRow, chatSchema, type ChatRow } from "./shared.js";

export interface ChatCreateOptions extends CommandOptions {
  isolation?: string;
  path?: string;
  project?: string;
  title?: string;
  mode?: string;
  worktreeSlug?: string;
  newBranch?: string;
  base?: string;
  branch?: string;
  prNumber?: string;
  forge?: string;
  background?: boolean;
}

interface WorktreeSourceBase {
  kind: "worktree";
  cwd?: string;
  projectId?: string;
  worktreeSlug?: string;
}

function assertOptionsAbsent(values: unknown[], message: string): void {
  if (values.some((value) => value !== undefined)) {
    throw new Error(message);
  }
}

function buildLocalChatSource(options: ChatCreateOptions, path: string) {
  assertOptionsAbsent(
    [
      options.mode,
      options.worktreeSlug,
      options.newBranch,
      options.base,
      options.branch,
      options.prNumber,
      options.forge,
    ],
    "Worktree options require --isolation worktree",
  );
  return {
    kind: "directory" as const,
    path,
    ...(options.project ? { projectId: options.project } : {}),
  };
}

function buildBranchOffSource(options: ChatCreateOptions, source: WorktreeSourceBase) {
  assertOptionsAbsent(
    [options.branch, options.prNumber, options.forge],
    "--branch, --pr-number, and --forge require a checkout mode",
  );
  return {
    ...source,
    action: "branch-off" as const,
    ...(options.newBranch ? { branchName: options.newBranch } : {}),
    ...(options.base ? { baseBranch: options.base } : {}),
  };
}

function buildBranchCheckoutSource(options: ChatCreateOptions, source: WorktreeSourceBase) {
  if (!options.branch) {
    throw new Error("--branch is required for --mode checkout-branch");
  }
  assertOptionsAbsent(
    [options.newBranch, options.base, options.prNumber, options.forge],
    "--new-branch, --base, --pr-number, and --forge are not valid for --mode checkout-branch",
  );
  return { ...source, action: "checkout" as const, refName: options.branch };
}

function buildPullRequestCheckoutSource(options: ChatCreateOptions, source: WorktreeSourceBase) {
  if (options.prNumber === undefined || options.prNumber === "") {
    throw new Error("--pr-number is required for --mode checkout-pr");
  }
  const prNumber = Number(options.prNumber);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error("--pr-number must be a positive integer");
  }
  assertOptionsAbsent(
    [options.newBranch, options.base, options.branch],
    "--new-branch, --base, and --branch are not valid for --mode checkout-pr",
  );
  return {
    ...source,
    action: "checkout" as const,
    checkoutSource: {
      kind: "change_request" as const,
      ...(options.forge ? { forge: options.forge } : {}),
      number: prNumber,
    },
  };
}

function buildWorktreeChatSource(options: ChatCreateOptions, path: string | undefined) {
  const source: WorktreeSourceBase = {
    kind: "worktree",
    ...(path ? { cwd: path } : {}),
    ...(options.project ? { projectId: options.project } : {}),
    ...(options.worktreeSlug ? { worktreeSlug: options.worktreeSlug } : {}),
  };
  switch (options.mode ?? "branch-off") {
    case "branch-off":
      return buildBranchOffSource(options, source);
    case "checkout-branch":
      return buildBranchCheckoutSource(options, source);
    case "checkout-pr":
      return buildPullRequestCheckoutSource(options, source);
    default:
      throw new Error(`Unsupported worktree mode: ${String(options.mode)}`);
  }
}

export function buildChatSource(options: ChatCreateOptions) {
  if (options.isolation === "local") {
    return buildLocalChatSource(options, options.path ?? process.cwd());
  }
  if (options.isolation === "worktree") {
    const sourcePath = options.path ?? (options.project ? undefined : process.cwd());
    return buildWorktreeChatSource(options, sourcePath);
  }
  throw new Error(`Unsupported chat isolation: ${String(options.isolation)}`);
}

export async function runCreateCommand(
  options: ChatCreateOptions,
  _command: Command,
): Promise<SingleResult<ChatRow>> {
  const host = getDaemonHost({ target: options.daemonTarget });
  const client = await connectToDaemon({ target: options.daemonTarget }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
    } satisfies CommandError;
  });

  try {
    const callerAgentId = await resolveCallerAgentId(client);
    const payload = await client.createWorkspace({
      source: buildChatSource(options),
      ...(options.title ? { title: options.title } : {}),
      ...(options.background !== undefined ? { background: options.background } : {}),
      ...(callerAgentId ? { callerAgentId } : {}),
    });
    if (!payload.workspace) {
      throw new Error(payload.error ?? "Chat creation failed");
    }
    return { type: "single", data: toChatRow(payload.workspace), schema: chatSchema };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw { code: "CHAT_CREATE_FAILED", message } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}
