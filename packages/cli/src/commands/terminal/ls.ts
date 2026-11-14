import type { Command } from "commander";
import type { ListResult } from "../../output/index.js";
import {
  connectTerminalClient,
  toTerminalCommandError,
  type TerminalCommandOptions,
} from "./shared.js";
import { terminalSchema, toTerminalRow, type TerminalRow } from "./schema.js";

export interface TerminalLsOptions extends TerminalCommandOptions {
  chat?: string;
  all?: boolean;
  cwd?: string;
}

export async function runLsCommand(
  options: TerminalLsOptions,
  _command: Command,
): Promise<ListResult<TerminalRow>> {
  const { client, close } = await connectTerminalClient(options.daemonTarget);
  const cwd = options.all || options.chat ? undefined : (options.cwd ?? process.cwd());

  try {
    const payload = await client.terminals.list({ cwd, workspaceId: options.chat });
    return {
      type: "list",
      data: payload.entries.map(toTerminalRow),
      schema: terminalSchema,
    };
  } catch (err) {
    throw toTerminalCommandError("TERMINAL_LIST_FAILED", "list terminals", err);
  } finally {
    await close().catch(() => {});
  }
}
