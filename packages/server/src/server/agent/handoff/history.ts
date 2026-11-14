import type { AgentTaskItem } from "@pimi/protocol/agent-types";
import { curateHistoryEntries, type CuratedHistoryEntry } from "../activity-curator.js";
import type { AgentTimelineRow } from "../agent-timeline-store-types.js";
import { projectTimelineRows } from "../timeline-projection.js";

/** Bumped when the summary prompt or template changes enough to make cached summaries stale. */
export const HANDOFF_FORMAT = 1;

/** History at or under this many curated characters is sent whole; no model is asked. */
export const VERBATIM_BUDGET_CHARS = 24_000;
/** Newest curated entries kept while scanning, enough to fill any tail the message can carry. */
const TAIL_KEEP_CHARS = 48_000;
const MAX_ENTRY_CHARS = 6_000;
const WRAPPER_TAG = /<(\/?)chat-history-summary\b[^>]*>/gi;

/** The stored timeline of one chat, read oldest to newest in turn-aligned blocks. */
export interface HandoffHistorySource {
  epoch(): string;
  maxSeq(): number | null;
  blocks(afterSeq: number): AsyncGenerator<AgentTimelineRow[]>;
}

export type HistoryEntry = CuratedHistoryEntry;

export function entriesFromRows(rows: readonly AgentTimelineRow[]): HistoryEntry[] {
  return curateHistoryEntries(projectTimelineRows({ rows, mode: "projected" }));
}

/** Cuts a summary at a line end under `max`; the tail sections it loses are in the transcript. */
export function clipSummary(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf("\n", max);
  return `${text.slice(0, cut > max * 0.7 ? cut : max)}\n[summary cut to fit; the transcript has the rest]`;
}

/** Keeps both ends of a long text; the stored timeline and the transcript hold the rest. */
export function clipMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.ceil(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head)}\n[... ${text.length - max} characters omitted ...]\n${text.slice(text.length - tail)}`;
}

/**
 * Quoted history sits inside the handoff wrapper and under its section headings. A line that
 * starts with `#`, or a copy of the wrapper tag, would read as structure of the message itself.
 */
export function escapeQuoted(text: string): string {
  return text
    .replace(WRAPPER_TAG, (_, slash: string) => `&lt;${slash}chat-history-summary&gt;`)
    .replace(/^([ \t]*)#/gm, "$1\\#");
}

export function entryText(entry: HistoryEntry): string {
  return escapeQuoted(clipMiddle(entry.text, MAX_ENTRY_CHARS));
}

export interface HistoryScan {
  epoch: string;
  maxSeq: number;
  entryCount: number;
  totalChars: number;
  /** The first user request, or null when the chat has none. */
  firstRequest: string | null;
  /** Every entry, only while the whole history fits VERBATIM_BUDGET_CHARS. */
  all: HistoryEntry[] | null;
  /** The newest entries, oldest first. */
  tail: HistoryEntry[];
  lastTodo: AgentTaskItem[] | null;
}

/**
 * One forward pass over the stored rows. Memory stays bounded: it keeps the newest
 * TAIL_KEEP_CHARS of entries, and everything only while the history is short enough to send whole.
 */
export async function scanHistory(source: HandoffHistorySource): Promise<HistoryScan> {
  const scan: HistoryScan = {
    epoch: source.epoch(),
    maxSeq: 0,
    entryCount: 0,
    totalChars: 0,
    firstRequest: null,
    all: [],
    tail: [],
    lastTodo: null,
  };
  let tailChars = 0;
  for await (const rows of source.blocks(0)) {
    scan.maxSeq = Math.max(scan.maxSeq, rows.at(-1)?.seq ?? 0);
    const projected = projectTimelineRows({ rows, mode: "projected" });
    for (const row of projected) {
      if (row.item.type === "todo") scan.lastTodo = row.item.items;
    }
    for (const entry of curateHistoryEntries(projected)) {
      scan.entryCount += 1;
      scan.totalChars += entry.text.length + 1;
      if (entry.turnStart && scan.firstRequest === null) scan.firstRequest = entry.text;
      scan.all?.push(entry);
      if (scan.totalChars > VERBATIM_BUDGET_CHARS) scan.all = null;
      scan.tail.push(entry);
      tailChars += entry.text.length;
      while (tailChars > TAIL_KEEP_CHARS && scan.tail.length > 1) {
        tailChars -= scan.tail.shift()!.text.length;
      }
    }
  }
  return scan;
}

/**
 * The newest entries that fit `budget` characters, cut so they start where a turn starts. A turn
 * longer than the budget is cut mid-turn instead. `fromSeq` is the first seq the tail covers.
 */
export function selectTail(
  entries: readonly HistoryEntry[],
  budget: number,
): { entries: HistoryEntry[]; fromSeq: number } {
  let used = 0;
  let start = entries.length;
  while (start > 0) {
    const size = Math.min(entries[start - 1]!.text.length, MAX_ENTRY_CHARS) + 1;
    if (used + size > budget && start < entries.length) break;
    used += size;
    start -= 1;
  }
  let first = start;
  if (first > 0 && first < entries.length) {
    const boundary = entries.findIndex((entry, index) => index >= first && entry.turnStart);
    if (boundary >= 0) first = boundary;
  }
  const selected = entries.slice(first);
  return { entries: selected, fromSeq: selected[0]?.seqStart ?? Number.POSITIVE_INFINITY };
}
