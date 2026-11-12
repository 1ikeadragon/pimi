import type { AgentTimelineItem, ToolCallDetail } from "../agent-sdk-types.js";
import type { AgentTimelineRow } from "../agent-timeline-store-types.js";
import { projectTimelineRows } from "../timeline-projection.js";

export type TimelineDocumentKind = "user" | "assistant" | "tool";

export interface TimelineDocument {
  seqStart: number;
  seqEnd: number;
  kind: TimelineDocumentKind;
  timestamp: string;
  text: string;
}

/** Most of a tool call's input that is indexed; a command or path is short, a patch is not. */
export const TOOL_INPUT_INDEX_CHARS = 2048;

function clip(text: string): string {
  return text.length > TOOL_INPUT_INDEX_CHARS ? text.slice(0, TOOL_INPUT_INDEX_CHARS) : text;
}

function joinParts(parts: ReadonlyArray<string | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join(" ");
}

/** What a tool call was asked to do (command, path, pattern, URL), never what it returned. */
export function summarizeToolInput(detail: ToolCallDetail): string {
  switch (detail.type) {
    case "shell":
      return joinParts([detail.command, detail.cwd]);
    case "read":
    case "edit":
    case "write":
      return detail.filePath;
    case "search":
      return detail.query;
    case "fetch":
      return joinParts([detail.url, detail.prompt]);
    case "worktree_setup":
      return joinParts([detail.worktreePath, detail.branchName]);
    case "sub_agent":
      return joinParts([detail.subAgentType, detail.description]);
    case "plain_text":
      return joinParts([detail.label, detail.text]);
    case "plan":
      return detail.text;
    case "unknown":
      return typeof detail.input === "string" ? detail.input : safeJson(detail.input);
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function documentText(
  item: AgentTimelineItem,
): { kind: TimelineDocumentKind; text: string } | null {
  switch (item.type) {
    case "user_message":
      return { kind: "user", text: item.text };
    case "assistant_message":
      return { kind: "assistant", text: item.text };
    case "tool_call":
      // A delivered agent message is conversation, not a tool the model ran.
      if (item.agentMessage) return null;
      return { kind: "tool", text: joinParts([item.name, clip(summarizeToolInput(item.detail))]) };
    default:
      return null;
  }
}

/**
 * Search documents for rows (ascending seq): one per user message, merged assistant message and
 * tool call. Tool output, reasoning, compaction summaries, todos and errors are not indexed.
 * Entries are projected the way the timeline shows them, so a document's `seqEnd` is the seq a
 * client addresses that entry by.
 */
export function buildTimelineDocuments(rows: readonly AgentTimelineRow[]): TimelineDocument[] {
  const documents: TimelineDocument[] = [];
  for (const entry of projectTimelineRows({ rows, mode: "projected" })) {
    const extracted = documentText(entry.item);
    if (!extracted || extracted.text.trim().length === 0) continue;
    documents.push({
      seqStart: entry.seqStart,
      seqEnd: entry.seqEnd,
      kind: extracted.kind,
      timestamp: entry.timestamp,
      text: extracted.text,
    });
  }
  return documents;
}
