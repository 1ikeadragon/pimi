import type { Command } from "commander";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandError, OutputSchema, SingleResult } from "../../output/index.js";

interface ChatSetupResult {
  chatId: string;
  status: "started" | "already_allowed";
}

const chatSetupSchema: OutputSchema<ChatSetupResult> = {
  idField: "chatId",
  columns: [
    { header: "CHAT ID", field: "chatId", width: 20 },
    { header: "STATUS", field: "status", width: 18 },
  ],
};

export async function runSetupCommand(
  chatId: string,
  options: { host?: string; daemonTarget: import("../../utils/daemon-target.js").DaemonTarget },
  _command: Command,
): Promise<SingleResult<ChatSetupResult>> {
  const host = getDaemonHost({ target: options.daemonTarget });
  const client = await connectToDaemon({ target: options.daemonTarget }).catch((error: unknown) => {
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${error instanceof Error ? error.message : String(error)}`,
    } satisfies CommandError;
  });
  try {
    const payload = await client.runWorkspaceSetup(chatId);
    if (payload.error) throw new Error(payload.error);
    return {
      type: "single",
      data: { chatId, status: payload.started ? "started" : "already_allowed" },
      schema: chatSetupSchema,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw { code: "CHAT_SETUP_FAILED", message } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}
