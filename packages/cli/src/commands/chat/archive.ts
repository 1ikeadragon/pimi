import type { Command } from "commander";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandError, OutputSchema, SingleResult } from "../../output/index.js";

interface ChatArchiveResult {
  chatId: string;
  status: "archived";
  archivedAt: string;
}

const chatArchiveSchema: OutputSchema<ChatArchiveResult> = {
  idField: "chatId",
  columns: [
    { header: "CHAT ID", field: "chatId", width: 20 },
    { header: "STATUS", field: "status", width: 10 },
    { header: "ARCHIVED AT", field: "archivedAt", width: 26 },
  ],
};

export async function runArchiveCommand(
  chatId: string,
  options: { host?: string; daemonTarget: import("../../utils/daemon-target.js").DaemonTarget },
  _command: Command,
): Promise<SingleResult<ChatArchiveResult>> {
  const host = getDaemonHost({ target: options.daemonTarget });
  const client = await connectToDaemon({ target: options.daemonTarget }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
    } satisfies CommandError;
  });
  try {
    const payload = await client.archiveWorkspace(chatId);
    if (payload.error) {
      throw new Error(payload.error);
    }
    if (!payload.archivedAt) {
      throw new Error("Chat archive did not return an archive timestamp");
    }
    return {
      type: "single",
      data: { chatId, status: "archived", archivedAt: payload.archivedAt },
      schema: chatArchiveSchema,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw { code: "CHAT_ARCHIVE_FAILED", message } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}
