import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

const PROMPT_PREVIEW_MAX_LENGTH = 120;
const PROMPT_PAGE_MAX_LIMIT = 100;

export interface TimelinePromptIndexEntry {
  seq: number;
  timestamp: string;
  preview: string;
}

export interface TimelinePromptIndex {
  epoch: string;
  prompts: TimelinePromptIndexEntry[];
}

export interface TimelinePromptPageEntry extends TimelinePromptIndexEntry {
  text: string;
}

export interface TimelinePromptPage {
  epoch: string;
  /** Oldest first, like the index. */
  prompts: TimelinePromptPageEntry[];
  hasOlder: boolean;
}

export interface TimelinePromptPageOptions {
  /** Only prompts before this position; omitted starts from the newest. */
  beforeSeq?: number;
  limit: number;
}

function promptPreview(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= PROMPT_PREVIEW_MAX_LENGTH) {
    return collapsed;
  }
  return `${collapsed.slice(0, PROMPT_PREVIEW_MAX_LENGTH - 1)}…`;
}

export function buildTimelinePromptIndex(
  epoch: string,
  rows: readonly AgentTimelineRow[],
): TimelinePromptIndex {
  return {
    epoch,
    prompts: rows.flatMap((row) =>
      row.item.type === "user_message"
        ? [
            {
              seq: row.seq,
              timestamp: row.timestamp,
              preview: promptPreview(row.item.text),
            },
          ]
        : [],
    ),
  };
}

/** The index carries previews of every prompt; a page carries the full text of a bounded few. */
export function buildTimelinePromptPage(
  epoch: string,
  rows: readonly AgentTimelineRow[],
  options: TimelinePromptPageOptions,
): TimelinePromptPage {
  const limit = Math.min(options.limit, PROMPT_PAGE_MAX_LIMIT);
  const beforeSeq = options.beforeSeq ?? Number.POSITIVE_INFINITY;
  const newestFirst: TimelinePromptPageEntry[] = [];
  let hasOlder = false;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.item.type !== "user_message" || row.seq >= beforeSeq) continue;
    if (newestFirst.length === limit) {
      hasOlder = true;
      break;
    }
    newestFirst.push({
      seq: row.seq,
      timestamp: row.timestamp,
      preview: promptPreview(row.item.text),
      text: row.item.text,
    });
  }
  return { epoch, prompts: newestFirst.toReversed(), hasOlder };
}
