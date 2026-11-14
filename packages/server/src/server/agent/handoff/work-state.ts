import type { AgentTaskItem } from "@pimi/protocol/agent-types";
import { runGitCommand } from "../../../utils/run-git-command.js";
import { clipMiddle, escapeQuoted } from "./history.js";

const GIT_TIMEOUT_MS = 2_000;
const MAX_STATUS_PATHS = 50;
const MAX_DIFF_STAT_CHARS = 1_500;
const MAX_TASKS = 10;
/** The Workspace section never grows past this, whatever the pieces add up to. */
export const WORK_STATE_MAX_CHARS = 2_500;

export interface OpenTask {
  title: string;
  status: string;
}

export interface WorkStateInput {
  cwd: string;
  lastTodo: readonly AgentTaskItem[] | null;
  readOpenTasks: () => Promise<OpenTask[]>;
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const result = await runGitCommand(args, { cwd, timeout: GIT_TIMEOUT_MS });
    return result.stdout.trim();
  } catch {
    // Not a repository, git missing or too slow: the section is left out, never the switch.
    return null;
  }
}

async function withTimeout<T>(work: Promise<T>): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), GIT_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([work.catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Where the work stands in the directory, read at switch time: branch, changed files, diff
 * summary, the chat's latest to-do list and the open Pimi tasks linked to it. Each piece has its
 * own 2 s limit and a failed piece is dropped. Returns null when nothing could be read.
 */
export async function collectWorkState(input: WorkStateInput): Promise<string | null> {
  const [branch, status, diffStat, tasks] = await Promise.all([
    git(input.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(input.cwd, ["status", "--porcelain"]),
    git(input.cwd, ["diff", "--stat", "HEAD"]),
    withTimeout(input.readOpenTasks()),
  ]);
  const parts: string[] = [];
  if (branch) parts.push(`Branch: ${branch}`);
  if (status !== null) {
    const paths = status.split("\n").filter(Boolean);
    const shown = paths.slice(0, MAX_STATUS_PATHS);
    parts.push(
      paths.length === 0
        ? "Changed files: none (working tree clean)"
        : `Changed files (${paths.length}):\n${shown.join("\n")}${
            paths.length > shown.length ? `\n... ${paths.length - shown.length} more` : ""
          }`,
    );
  }
  if (diffStat) parts.push(`Diff against HEAD:\n${clipMiddle(diffStat, MAX_DIFF_STAT_CHARS)}`);
  const todo = input.lastTodo?.filter((entry) => !entry.completed) ?? [];
  if (todo.length > 0) {
    parts.push(
      `Open items in the chat's latest to-do list:\n${todo
        .slice(0, MAX_TASKS)
        .map((entry) => `- ${entry.text}`)
        .join("\n")}`,
    );
  }
  if (tasks && tasks.length > 0) {
    parts.push(
      `Open Pimi tasks linked to this chat:\n${tasks
        .slice(0, MAX_TASKS)
        .map((task) => `- [${task.status}] ${task.title}`)
        .join("\n")}`,
    );
  }
  if (parts.length === 0) return null;
  return clipMiddle(escapeQuoted(parts.join("\n\n")), WORK_STATE_MAX_CHARS);
}
