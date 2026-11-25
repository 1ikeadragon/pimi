import { isAbsolute, relative } from "node:path";
import { ACTION_ITEM_TEXT_MAX_LENGTH } from "@pimi/protocol/action-items/types";
import type { ToolCallTimelineItem } from "../agent/agent-sdk-types.js";

/**
 * What the action-items model is told about a chat's tool calls. The assistant's text says "tests
 * pass"; the shell call shows the command, exit code and output that prove it. Only calls whose
 * result can show an item finished are digested: shell commands, file edits and writes, and
 * subagents. Reads, searches, fetches, plans, unknown tools and calls that are still running or
 * were canceled say nothing about whether work finished, so they are left out by kind, not by
 * budget, and the prompt says so.
 */

// A command, file path or description is clipped to this. Reused from the item text limit: both
// are one line the model writes or reads. Borrowed, not derived.
const TOOL_LINE_CHARS = ACTION_ITEM_TEXT_MAX_LENGTH;
// The end of a command's output holds its verdict (the failing assertion, the summary line).
// A guess, not measured: about four lines of test-runner summary. Tune against real chats.
const TOOL_OUTPUT_TAIL_CHARS = 300;
// Files named in a collapsed "edited N files" line. Chosen to keep that line near TOOL_LINE_CHARS
// for typical relative paths.
const EDIT_SUMMARY_FILES = 3;

type ToolLineKind = "shell" | "edit" | "subagent";

export interface ToolLine {
  kind: ToolLineKind;
  text: string;
  /** Set on edit lines, to merge consecutive edits of one file and to name files when collapsed. */
  path?: string;
}

interface DigestLine {
  kind: ToolLineKind;
  text: string;
  calls: number;
  path?: string;
}

// Over budget, lines are kept in this order: a command's exit code is the strongest proof.
const KEEP_PRIORITY: Record<ToolLineKind, number> = { shell: 0, edit: 1, subagent: 2 };

function omitted(count: number): string {
  return `[... ${count} chars omitted ...]`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clipHead(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}${omitted(text.length - max)}`;
}

function clipTail(text: string, max: number): string {
  return text.length <= max ? text : `${omitted(text.length - max)}\n${text.slice(-max)}`;
}

function displayPath(cwd: string, filePath: string): string {
  const rel = isAbsolute(filePath) ? relative(cwd, filePath) : filePath;
  const shown = rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : filePath;
  return clipHead(shown, TOOL_LINE_CHARS);
}

/** One line (or a command line plus its output tail) for a tool call, or null if it is not digested. */
export function describeToolCall(item: ToolCallTimelineItem, cwd: string): ToolLine | null {
  if (item.status !== "completed" && item.status !== "failed") return null;
  const { detail } = item;
  switch (detail.type) {
    case "shell": {
      const verdict =
        detail.exitCode !== undefined && detail.exitCode !== null
          ? `exit ${detail.exitCode}`
          : item.status;
      const head = `$ ${clipHead(oneLine(detail.command), TOOL_LINE_CHARS)} -> ${verdict}`;
      const output = detail.output?.trim() ?? "";
      return {
        kind: "shell",
        text: output ? `${head}\n${clipTail(output, TOOL_OUTPUT_TAIL_CHARS)}` : head,
      };
    }
    case "edit":
    case "write": {
      // A failed edit changed nothing; saying "edited" would be wrong, and it proves nothing.
      if (item.status === "failed") return null;
      const path = displayPath(cwd, detail.filePath);
      return { kind: "edit", text: `edited ${path}`, path };
    }
    case "sub_agent": {
      const label = oneLine(detail.description ?? detail.subAgentType ?? "");
      if (!label) return null;
      return {
        kind: "subagent",
        text: `subagent: ${clipHead(label, TOOL_LINE_CHARS)} -> ${item.status}`,
      };
    }
    default:
      return null;
  }
}

// Consecutive edits of one file become one line: an agent that edits a file ten times in a row
// did one piece of work.
function mergeEdits(group: readonly ToolLine[]): DigestLine[] {
  const lines: DigestLine[] = [];
  for (const line of group) {
    const last = lines[lines.length - 1];
    if (line.kind === "edit" && last?.kind === "edit" && last.path === line.path) {
      last.calls += 1;
      last.text = `edited ${line.path} (${last.calls} times)`;
      continue;
    }
    lines.push({
      kind: line.kind,
      text: line.text,
      calls: 1,
      ...(line.path !== undefined ? { path: line.path } : {}),
    });
  }
  return lines;
}

// All of a group's edit lines become one: "edited 4 files: a.ts, b.ts, c.ts (+1 more)".
function collapseEdits(lines: readonly DigestLine[]): DigestLine[] {
  const edits = lines.filter((line) => line.kind === "edit");
  if (edits.length < 2) return [...lines];
  const paths = [...new Set(edits.map((line) => line.path ?? ""))];
  const named = paths.slice(0, EDIT_SUMMARY_FILES).join(", ");
  const more = paths.length - EDIT_SUMMARY_FILES;
  const summary: DigestLine = {
    kind: "edit",
    text: `edited ${paths.length} files: ${named}${more > 0 ? ` (+${more} more)` : ""}`,
    calls: edits.reduce((sum, line) => sum + line.calls, 0),
  };
  const result: DigestLine[] = [];
  let placed = false;
  for (const line of lines) {
    if (line.kind !== "edit") {
      result.push(line);
    } else if (!placed) {
      result.push(summary);
      placed = true;
    }
  }
  return result;
}

function cost(lines: readonly DigestLine[]): number {
  // The newline that joins the line to the next.
  return lines.reduce((sum, line) => sum + line.text.length + 1, 0);
}

function marker(count: number): string {
  return `[${count} tool ${count === 1 ? "call" : "calls"} omitted]`;
}

/**
 * One digest text per group of consecutive tool calls, `groups` in chat order, within `budget`
 * characters in all. Over budget: each group's edits collapse into one line; still over: lines are
 * kept shell first, then edits, then subagents, newest first within a kind, and a group that lost
 * calls ends with "[k tool calls omitted]". The marker is not charged to the budget, so nothing
 * is dropped without the model being told.
 */
export function buildToolDigest(
  groups: readonly (readonly ToolLine[])[],
  budget: number,
): string[] {
  let perGroup = groups.map(mergeEdits);
  if (perGroup.reduce((sum, lines) => sum + cost(lines), 0) > budget) {
    perGroup = perGroup.map(collapseEdits);
  }
  const lost = perGroup.map(() => 0);
  if (perGroup.reduce((sum, lines) => sum + cost(lines), 0) > budget) {
    const candidates = perGroup.flatMap((lines, group) =>
      lines.map((line, index) => ({ group, index, line })),
    );
    candidates.sort(
      (a, b) =>
        KEEP_PRIORITY[a.line.kind] - KEEP_PRIORITY[b.line.kind] ||
        b.group - a.group ||
        b.index - a.index,
    );
    const kept = new Set<DigestLine>();
    let used = 0;
    for (const { line } of candidates) {
      const lineCost = line.text.length + 1;
      if (used + lineCost > budget) continue;
      used += lineCost;
      kept.add(line);
    }
    perGroup = perGroup.map((lines, group) =>
      lines.filter((line) => {
        if (kept.has(line)) return true;
        lost[group] = (lost[group] ?? 0) + line.calls;
        return false;
      }),
    );
  }
  return perGroup.map((lines, group) => {
    const texts = lines.map((line) => line.text);
    const count = lost[group] ?? 0;
    if (count > 0) texts.push(marker(count));
    return texts.join("\n");
  });
}
