import type { Command } from "commander";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandError, ListResult } from "../../output/index.js";
import { toChatRow, chatSchema, chatWithBackgroundSchema, type ChatRow } from "./shared.js";

export interface ChatLsOptions {
  host?: string;
  daemonTarget: import("../../utils/daemon-target.js").DaemonTarget;
  /** --background: Include background chats */
  background?: boolean;
}

export async function runLsCommand(
  options: ChatLsOptions,
  _command: Command,
): Promise<ListResult<ChatRow>> {
  const host = getDaemonHost({ target: options.daemonTarget });
  const client = await connectToDaemon({ target: options.daemonTarget }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
    } satisfies CommandError;
  });
  try {
    const chats: ChatRow[] = [];
    let cursor: string | undefined;
    do {
      const payload = await client.fetchWorkspaces({
        ...(options.background ? { filter: { includeBackground: true } } : {}),
        page: { limit: 200, ...(cursor ? { cursor } : {}) },
      });
      chats.push(...payload.entries.map(toChatRow));
      cursor = payload.pageInfo.nextCursor ?? undefined;
    } while (cursor);
    return {
      type: "list",
      data: chats,
      schema: options.background ? chatWithBackgroundSchema : chatSchema,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}
