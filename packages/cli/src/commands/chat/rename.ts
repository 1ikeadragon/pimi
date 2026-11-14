import type { Command } from "commander";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandError, OutputSchema, SingleResult } from "../../output/index.js";

interface ChatRenameResult {
  chatId: string;
  /** Raw title override; null once it has been reset to the derived name. */
  title: string | null;
}

const chatRenameSchema: OutputSchema<ChatRenameResult> = {
  idField: "chatId",
  columns: [
    { header: "CHAT ID", field: "chatId", width: 20 },
    { header: "TITLE", field: "title", width: 30 },
  ],
};

export interface ChatRenameOptions {
  host?: string;
  daemonTarget: import("../../utils/daemon-target.js").DaemonTarget;
  reset?: boolean;
}

/**
 * Resolve the title to send to the daemon. Null clears the override and
 * reverts the chat to its branch- or directory-derived name.
 */
export function resolveChatTitle(input: { title?: string; reset?: boolean }): string | null {
  const title = input.title?.trim() ?? "";
  if (input.reset) {
    if (input.title !== undefined) {
      throw {
        code: "INVALID_OPTIONS",
        message: "--reset cannot be combined with a title",
        details: "Pass a title to rename the chat, or --reset to revert to the derived name",
      } satisfies CommandError;
    }
    return null;
  }
  if (title.length === 0) {
    throw {
      code: "MISSING_TITLE",
      message: "Title cannot be empty",
      details: "Usage: pimi chat rename <chat-id> <title> | --reset",
    } satisfies CommandError;
  }
  return title;
}

export async function runRenameCommand(
  chatId: string,
  titleArg: string | undefined,
  options: ChatRenameOptions,
  _command: Command,
): Promise<SingleResult<ChatRenameResult>> {
  const title = resolveChatTitle({ title: titleArg, reset: options.reset });

  const host = getDaemonHost({ target: options.daemonTarget });
  const client = await connectToDaemon({ target: options.daemonTarget }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
      details: "Start the daemon with: pimi daemon start",
    } satisfies CommandError;
  });
  try {
    const applied = await client.setWorkspaceTitle(chatId, title);
    return {
      type: "single",
      data: { chatId, title: applied.title },
      schema: chatRenameSchema,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw { code: "CHAT_RENAME_FAILED", message } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}
