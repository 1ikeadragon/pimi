import { randomUUID } from "node:crypto";
import { TimelineProjection, type ProjectedTimelineRow } from "./timeline-projection.js";
import { limitAgentTimelineItemContent } from "./agent-timeline-content.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
} from "./agent-timeline-store-types.js";

export interface SeedAgentTimelineOptions {
  items?: readonly AgentTimelineItem[];
  rows?: readonly AgentTimelineRow[];
  epoch?: string;
  nextSeq?: number;
  timestamp?: string;
}

interface AgentTimelineState {
  epoch: string;
  projection: TimelineProjection;
  minSeq: number;
  nextSeq: number;
  completedCompactions: number;
  /** A windowed replay left older history in the provider; reading it extends the rows backwards. */
  olderAvailable: boolean;
}
/** First sequence number of a windowed replay, leaving room below it for older history. */
export const WINDOWED_TIMELINE_BASE_SEQ = 1_000_000_000;
const DEFAULT_TIMELINE_FETCH_LIMIT = 200;
function cloneRow<T extends AgentTimelineRow>(row: T): T {
  return { ...row };
}

function isCompletedCompaction(item: AgentTimelineItem): boolean {
  return item.type === "compaction" && item.status === "completed";
}

export class InMemoryAgentTimelineStore {
  private readonly states = new Map<string, AgentTimelineState>();

  has(agentId: string): boolean {
    return this.states.has(agentId);
  }

  initialize(agentId: string, options?: SeedAgentTimelineOptions): void {
    const timestamp = options?.timestamp ?? new Date().toISOString();
    const rows = options?.rows?.length
      ? options.rows.map(cloneRow)
      : this.buildRowsFromItems(options?.items ?? [], options?.nextSeq ?? 1, timestamp);
    const nextSeq = rows.reduce((next, row) => Math.max(next, row.seq + 1), options?.nextSeq ?? 1);
    const projection = new TimelineProjection(rows);
    this.states.set(agentId, {
      epoch: options?.epoch ?? randomUUID(),
      projection,
      minSeq: rows.length > 0 ? projection.findFirstRow(() => true)!.seqStart : 0,
      nextSeq,
      completedCompactions: rows.reduce(
        (count, row) => count + Number(isCompletedCompaction(row.item)),
        0,
      ),
      olderAvailable: false,
    });
  }

  /** Start numbering at `nextSeq` on a timeline that has no rows yet. */
  rebase(agentId: string, nextSeq: number): void {
    const state = this.requireState(agentId);
    if (state.minSeq !== 0) throw new Error(`Cannot rebase non-empty timeline for '${agentId}'`);
    state.nextSeq = nextSeq;
  }

  hasOlderAvailable(agentId: string): boolean {
    return this.states.get(agentId)?.olderAvailable === true;
  }

  setOlderAvailable(agentId: string, olderAvailable: boolean): void {
    this.requireState(agentId).olderAvailable = olderAvailable;
  }

  /** Rows (after projection) that start before `seq`; `Infinity` counts every row. */
  countRowsBefore(agentId: string, seq: number): number {
    return this.requireState(agentId).projection.countRowsBefore(seq);
  }

  /** Add older history in front of the first row, numbering it downwards from there. */
  prependItems(
    agentId: string,
    entries: readonly { item: AgentTimelineItem; timestamp?: string }[],
  ): void {
    const state = this.requireState(agentId);
    if (entries.length === 0) return;
    const firstSeq = state.minSeq === 0 ? state.nextSeq : state.minSeq;
    const startSeq = firstSeq - entries.length;
    if (startSeq < 1) throw new Error(`Timeline for '${agentId}' has no room for older history`);
    const timestamp = new Date().toISOString();
    const rows = entries.map(
      (entry, index): AgentTimelineRow => ({
        seq: startSeq + index,
        timestamp: entry.timestamp ?? timestamp,
        item: entry.item,
      }),
    );
    state.projection.prepend(rows);
    state.minSeq = startSeq;
    state.completedCompactions += rows.reduce(
      (count, row) => count + Number(isCompletedCompaction(row.item)),
      0,
    );
  }

  delete(agentId: string): void {
    this.states.delete(agentId);
  }

  getItems(agentId: string): AgentTimelineItem[] {
    return this.requireState(agentId)
      .projection.getRows()
      .map((row) => row.item);
  }

  /** The newest stored tool-call item for a call, with its whole (non-preview) detail. */
  findToolCall(
    agentId: string,
    callId: string,
    turnId?: string,
  ): Extract<AgentTimelineItem, { type: "tool_call" }> | null {
    const row = this.requireState(agentId).projection.findLastRow(
      (candidate) =>
        candidate.item.type === "tool_call" &&
        candidate.item.callId === callId &&
        (turnId === undefined || candidate.turnId === turnId),
    );
    return row?.item.type === "tool_call" ? row.item : null;
  }

  getRows(agentId: string): ProjectedTimelineRow[] {
    return this.requireState(agentId).projection.getRows().map(cloneRow);
  }

  getSubmittedUserMessage(agentId: string, clientMessageId: string): AgentTimelineRow | null {
    const row = this.requireState(agentId).projection.findFirstRow(
      (candidate) =>
        candidate.item.type === "user_message" &&
        candidate.item.clientMessageId === clientMessageId,
    );
    return row ? cloneRow(row) : null;
  }

  enrichSubmittedUserMessage(
    agentId: string,
    clientMessageId: string,
    providerMessageId: string,
  ): AgentTimelineRow | null {
    return this.requireState(agentId).projection.enrichSubmittedUserMessage(
      clientMessageId,
      providerMessageId,
    );
  }

  getEpoch(agentId: string): string {
    return this.requireState(agentId).epoch;
  }

  getCompletedCompactionCount(agentId: string): number {
    return this.requireState(agentId).completedCompactions;
  }

  fetch(agentId: string, options?: AgentTimelineFetchOptions): AgentTimelineFetchResult {
    const state = this.requireState(agentId);
    const direction = options?.direction ?? "tail";
    const cursor = options?.cursor;
    const hasRows = state.minSeq !== 0;
    const window = { minSeq: state.minSeq, maxSeq: state.nextSeq - 1, nextSeq: state.nextSeq };
    const staleCursor = cursor !== undefined && cursor.epoch !== state.epoch;
    const gap =
      !staleCursor &&
      direction === "after" &&
      cursor !== undefined &&
      hasRows &&
      cursor.seq < state.minSeq - 1;
    const reset = staleCursor || gap;
    const page = state.projection.selectPage({
      bounds: window,
      direction: reset ? "tail" : direction,
      cursorSeq: cursor?.seq,
      limit: options?.limit ?? DEFAULT_TIMELINE_FETCH_LIMIT,
      wholeTurns: options?.wholeTurns,
    });
    return {
      epoch: state.epoch,
      direction,
      reset,
      staleCursor,
      gap,
      window,
      hasOlder:
        page.hasOlder ||
        (state.olderAvailable && direction !== "after" && page.startSeq === state.minSeq),
      hasNewer: page.hasNewer,
      startSeq: page.startSeq,
      endSeq: page.endSeq,
      // Stored rows are already within budget; this bounds assistant and reasoning merges.
      rows: page.entries.map((entry) =>
        Object.assign({ seq: entry.seqEnd }, entry, {
          item: limitAgentTimelineItemContent(entry.item),
        }),
      ),
    };
  }

  append(
    agentId: string,
    item: AgentTimelineItem,
    options?: { timestamp?: string; providerMessageId?: string; turnId?: string },
  ): AgentTimelineRow {
    const state = this.requireState(agentId);
    const row: AgentTimelineRow = {
      seq: state.nextSeq,
      timestamp: options?.timestamp ?? new Date().toISOString(),
      item,
      ...(options?.turnId ? { turnId: options.turnId } : {}),
      ...(options?.providerMessageId ? { providerMessageId: options.providerMessageId } : {}),
    };
    state.nextSeq += 1;
    if (state.minSeq === 0) state.minSeq = row.seq;
    state.projection.append(row);
    if (isCompletedCompaction(item)) state.completedCompactions += 1;
    return cloneRow(row);
  }

  getLastItem(agentId: string): AgentTimelineItem | null {
    const state = this.requireState(agentId);
    return state.projection.getLastItem(state.nextSeq - 1);
  }

  getLastAssistantMessage(agentId: string): string | null {
    return this.requireState(agentId).projection.getLastAssistantMessage();
  }

  private requireState(agentId: string): AgentTimelineState {
    const state = this.states.get(agentId);
    if (!state) {
      throw new Error(`Unknown agent '${agentId}'`);
    }
    return state;
  }

  private buildRowsFromItems(
    items: readonly AgentTimelineItem[],
    startSeq: number,
    timestamp: string,
  ): AgentTimelineRow[] {
    let nextSeq = startSeq;
    return items.map((item) => {
      const row: AgentTimelineRow = {
        seq: nextSeq,
        timestamp,
        item,
      };
      nextSeq += 1;
      return row;
    });
  }
}
