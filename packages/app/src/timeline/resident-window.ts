import { startsNewTurn } from "@/agent-stream/turn-membership";
import type { StreamItem } from "@/types/stream";
import type { TimelineCursor, TimelineLoadedRange } from "./session-stream-reducers";

/**
 * The most projected rows one chat keeps resident in the client store: 400 items or 4 MB of
 * payload, whichever is reached first. The daemon and `pimi-timeline.db` hold the full chat and
 * serve any other window on demand, so resident history only has to cover what a reader can
 * scroll through between fetches. The cost of every derived structure (presentation, render
 * model, layout) is linear in this array, so the cap also bounds the long task a page costs.
 */
export const RESIDENT_WINDOW_CAP = { items: 400, bytes: 4 * 1024 * 1024 } as const;

/**
 * A trim cuts down to this share of the cap, so a chat sitting at the cap does not trim on
 * every appended row; it trims once per ~quarter of the cap.
 */
const TRIM_TARGET_RATIO = 0.75;

const itemBytesCache = new WeakMap<object, number>();

function estimateValueBytes(value: unknown, depth: number): number {
  if (typeof value === "string") return value.length;
  if (typeof value !== "object" || value === null) return 8;
  if (value instanceof Date) return 8;
  if (depth >= 8) return 16;
  let total = 16;
  if (Array.isArray(value)) {
    for (const entry of value) total += estimateValueBytes(entry, depth + 1);
    return total;
  }
  for (const key in value as Record<string, unknown>) {
    total += key.length + estimateValueBytes((value as Record<string, unknown>)[key], depth + 1);
  }
  return total;
}

/** Cheap structural size, cached per row identity: a streamed delta re-measures one row. */
export function estimateStreamItemBytes(item: StreamItem): number {
  let bytes = itemBytesCache.get(item);
  if (bytes === undefined) {
    bytes = estimateValueBytes(item, 0);
    itemBytesCache.set(item, bytes);
  }
  return bytes;
}

export function measureResidentTail(tail: readonly StreamItem[]): { items: number; bytes: number } {
  let bytes = 0;
  for (const item of tail) bytes += estimateStreamItemBytes(item);
  return { items: tail.length, bytes };
}

export function exceedsResidentWindow(tail: readonly StreamItem[]): boolean {
  if (tail.length > RESIDENT_WINDOW_CAP.items) return true;
  return measureResidentTail(tail).bytes > RESIDENT_WINDOW_CAP.bytes;
}

export type ResidentTrimEnd = "oldest" | "newest";

export interface ResidentTrimResult {
  tail: StreamItem[];
  cursor: TimelineCursor;
  /** Set only when the trim changed it. */
  older?: "available";
  newer?: "available";
}

/**
 * A row where a whole-turn cut is exact: a submitted prompt carries one seq, so it is both
 * the first and the last source row of its row, and `before startSeq` / `after endSeq`
 * continue exactly from it. A merged assistant row or a tool lifecycle spans several seqs and
 * cannot name the seq before its first source row.
 */
function isCutRow(items: readonly StreamItem[], index: number, epoch: string): boolean {
  const item = items[index];
  if (item.kind !== "user_message") return false;
  if (item.timelineCursor?.epoch !== epoch) return false;
  return startsNewTurn(item, items[index - 1] ?? null);
}

function prefixBytes(items: readonly StreamItem[]): number[] {
  const prefix: number[] = [0];
  for (let index = 0; index < items.length; index += 1) {
    prefix.push(prefix[index] + estimateStreamItemBytes(items[index]));
  }
  return prefix;
}

function seqOf(item: StreamItem, epoch: string): number | null {
  return item.timelineCursor?.epoch === epoch ? item.timelineCursor.seq : null;
}

/**
 * Drops whole turns from one end of the resident tail and moves the cursor with them.
 *
 * `oldest` runs while the reader follows new rows (live append, forward paging); `newest` runs
 * while the reader pages back into history. The cut is a turn boundary at a submitted prompt
 * so the new cursor edge is exact; the dropped range is reachable again through `before`
 * (oldest) or `after` (newest). Slicing without moving the cursor would certify rows the
 * client no longer holds (docs/timeline-sync.md, "Client replica lifetime").
 *
 * Returns null when the tail is within the cap or no safe cut exists (a single turn larger
 * than the cap, or rows without a timeline position that a cut would drop).
 */
export function trimResidentTail(input: {
  tail: readonly StreamItem[];
  cursor: TimelineCursor;
  end: ResidentTrimEnd;
}): ResidentTrimResult | null {
  const { tail, cursor, end } = input;
  if (!exceedsResidentWindow(tail)) return null;
  const targetItems = Math.floor(RESIDENT_WINDOW_CAP.items * TRIM_TARGET_RATIO);
  const targetBytes = Math.floor(RESIDENT_WINDOW_CAP.bytes * TRIM_TARGET_RATIO);
  const prefix = prefixBytes(tail);
  const total = prefix[tail.length];
  return end === "oldest"
    ? trimOldest({ tail, cursor, prefix, total, targetItems, targetBytes })
    : trimNewest({ tail, cursor, prefix, targetItems, targetBytes });
}

function trimOldest(input: {
  tail: readonly StreamItem[];
  cursor: TimelineCursor;
  prefix: number[];
  total: number;
  targetItems: number;
  targetBytes: number;
}): ResidentTrimResult | null {
  const { tail, cursor, prefix, total, targetItems, targetBytes } = input;
  // Rows that precede the cut must all be below the cut seq, or a spanning row would be
  // dropped from the array while still claimed by the retained range.
  let maxSeqBefore = -1;
  let firstFit: number | null = null;
  let lastValid: number | null = null;
  for (let index = 1; index < tail.length; index += 1) {
    const seq = seqOf(tail[index - 1], cursor.epoch);
    if (seq === null) {
      // A row with no position (a local submission) cannot be reasoned about.
      maxSeqBefore = Number.POSITIVE_INFINITY;
    } else if (seq > maxSeqBefore) {
      maxSeqBefore = seq;
    }
    if (!isCutRow(tail, index, cursor.epoch)) continue;
    const cutSeq = seqOf(tail[index], cursor.epoch);
    if (cutSeq === null || maxSeqBefore >= cutSeq) continue;
    lastValid = index;
    if (tail.length - index <= targetItems && total - prefix[index] <= targetBytes) {
      firstFit = index;
      break;
    }
  }
  const cut = firstFit ?? lastValid;
  if (cut === null) return null;
  const cutSeq = seqOf(tail[cut], cursor.epoch);
  if (cutSeq === null) return null;

  const retainedRanges: TimelineLoadedRange[] = [];
  for (const range of cursor.retainedRanges ?? []) {
    if (range.endSeq < cutSeq) continue;
    retainedRanges.push(
      range.startSeq < cutSeq ? { ...range, startSeq: cutSeq, hasOlder: true } : range,
    );
  }
  const mainStartsBeforeCut = cursor.startSeq < cutSeq;
  const nextCursor: TimelineCursor = {
    epoch: cursor.epoch,
    startSeq: mainStartsBeforeCut ? cutSeq : cursor.startSeq,
    endSeq: cursor.endSeq,
    ...(retainedRanges.length > 0 ? { retainedRanges } : {}),
  };
  return {
    tail: tail.slice(cut),
    cursor: nextCursor,
    ...(mainStartsBeforeCut ? { older: "available" as const } : {}),
  };
}

function trimNewest(input: {
  tail: readonly StreamItem[];
  cursor: TimelineCursor;
  prefix: number[];
  targetItems: number;
  targetBytes: number;
}): ResidentTrimResult | null {
  const { tail, cursor, prefix, targetItems, targetBytes } = input;
  // Keep at least one row of the contiguous main range: the cursor identifies the main range
  // as the one containing endSeq.
  let firstMainIndex = tail.length;
  for (let index = 0; index < tail.length; index += 1) {
    const seq = seqOf(tail[index], cursor.epoch);
    if (seq !== null && seq >= cursor.startSeq) {
      firstMainIndex = index;
      break;
    }
  }
  // Scan from the newest end for the largest retained prefix that fits. Rows after the cut must
  // all be at or above the cut seq, and all must have a position (a dropped local submission
  // would be lost, not re-fetched).
  const maxSeqBefore: number[] = [-1];
  for (let index = 0; index < tail.length; index += 1) {
    const seq = seqOf(tail[index], cursor.epoch);
    maxSeqBefore[index + 1] =
      seq === null ? maxSeqBefore[index] : Math.max(maxSeqBefore[index], seq);
  }
  let minSeqAfter = Number.POSITIVE_INFINITY;
  let unpositionedAfter = false;
  let fit: number | null = null;
  let smallestValid: number | null = null;
  for (let index = tail.length - 1; index > firstMainIndex; index -= 1) {
    const seq = seqOf(tail[index], cursor.epoch);
    if (seq === null) unpositionedAfter = true;
    else if (seq < minSeqAfter) minSeqAfter = seq;
    if (unpositionedAfter) continue;
    if (!isCutRow(tail, index, cursor.epoch)) continue;
    const cutSeq = seqOf(tail[index], cursor.epoch);
    if (cutSeq === null || minSeqAfter < cutSeq || maxSeqBefore[index] >= cutSeq) continue;
    smallestValid = index;
    if (fit === null && index <= targetItems && prefix[index] <= targetBytes) fit = index;
  }
  const cut = fit ?? smallestValid;
  if (cut === null) return null;
  const cutSeq = seqOf(tail[cut], cursor.epoch);
  if (cutSeq === null) return null;
  return {
    tail: tail.slice(0, cut),
    cursor: { ...cursor, endSeq: cutSeq - 1 },
    newer: "available",
  };
}
