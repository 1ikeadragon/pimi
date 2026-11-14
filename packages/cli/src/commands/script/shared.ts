import type { DaemonTarget } from "../../utils/daemon-target.js";
import { resolve } from "node:path";
import type { DaemonClient } from "@pimi/client/internal/daemon-client";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandError, CommandOptions } from "../../output/index.js";

export interface WorkspaceScriptCommandOptions extends CommandOptions {
  host?: string;
  cwd?: string;
  chat?: string;
}

export async function connectWorkspaceScriptClient(target: DaemonTarget): Promise<DaemonClient> {
  const daemonHost = getDaemonHost({ target });
  try {
    return await connectToDaemon({ target });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && "message" in error) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${daemonHost}: ${message}`,
      details: "Start the daemon with: pimi daemon start",
    } satisfies CommandError;
  }
}

export async function resolveWorkspaceScriptWorkspaceId(
  client: DaemonClient,
  options: WorkspaceScriptCommandOptions,
): Promise<string> {
  if (options.chat) {
    return options.chat;
  }

  const cwd = resolve(options.cwd ?? process.cwd());
  const payload = await client.fetchWorkspaces({ page: { limit: 200 } });
  const matches = payload.entries.filter(
    (workspace) => resolve(workspace.workspaceDirectory) === cwd,
  );
  if (matches.length === 1) {
    return matches[0]!.id;
  }
  if (matches.length > 1) {
    throw {
      code: "CHAT_AMBIGUOUS",
      message: `Multiple chats use ${cwd}`,
      details: "Pass --chat <chat-id> to select one.",
    } satisfies CommandError;
  }
  throw {
    code: "CHAT_NOT_FOUND",
    message: `No Pimi chat found for ${cwd}`,
    details: "Open the directory in Pimi first, or pass --chat <chat-id>.",
  } satisfies CommandError;
}

export function toWorkspaceScriptCommandError(
  code: string,
  action: string,
  error: unknown,
): CommandError {
  if (error && typeof error === "object" && "code" in error && "message" in error) {
    return error as CommandError;
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code, message: `Failed to ${action}: ${message}` };
}
