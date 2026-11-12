import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { StatementSync } from "node:sqlite";
import type { PimiDatabase } from "../db/pimi-db.js";
import { timelineFlushMetrics } from "../websocket/runtime-metrics.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

/**
 * Bump when the mapping from provider events to timeline items changes in a way that makes
 * stored rows differ from what a fresh replay would produce. A chat whose stored rows carry an
 * older format is rebuilt from its provider the next time it is opened.
 */
export const TIMELINE_ROW_FORMAT = 1;

const FLUSH_INTERVAL_MS = 50;
const FLUSH_URGENT_ROWS = 200;
const FLUSH_URGENT_BYTES = 1_000_000;
const FLUSH_CHUNK_ROWS = 500;
/** Rows read for the newest page of a chat; the page is extended back to a turn start. */
export const TIMELINE_OPEN_ROWS = 2000;

export interface StoredTimelineAgent {
  key: number;
  agentId: string;
  epoch: string;
  rowFormat: number;
  complete: boolean;
  openTurn: boolean;
  providerSubagents: boolean;
  sessionKey: string | null;
  fingerprint: string | null;
  indexedLo: number;
  indexedHi: number;
}

export interface TimelineRowBlock {
  rows: AgentTimelineRow[];
  /** Rows exist in the store below the first returned row. */
  hasOlder: boolean;
}

export type TimelineOpenRefusal =
  | "no_rows"
  | "incomplete"
  | "open_turn"
  | "session_changed"
  | "row_format"
  | "fingerprint"
  | "provider_subagents"
  | "flush_failed";

interface BoundAgent {
  key: number;
  epoch: string;
  open: boolean;
  failed: boolean;
  sessionKey: string | null;
  providerSubagents: boolean;
}

interface PendingWrite {
  agentId: string;
  epoch: string;
  row: AgentTimelineRow;
  carried: boolean;
}

export function timelineSessionKey(
  handle: { provider: string; sessionId: string; nativeHandle?: string } | null | undefined,
): string | null {
  if (!handle) return null;
  return `${handle.provider}:${handle.sessionId || handle.nativeHandle || ""}`;
}

function estimateBytes(item: AgentTimelineItem): number {
  switch (item.type) {
    case "assistant_message":
    case "reasoning":
    case "user_message":
      return 256 + item.text.length;
    case "tool_call":
      return 4096;
    default:
      return 512;
  }
}

function parseRow(row: Record<string, unknown>): AgentTimelineRow {
  const item = JSON.parse(String(row.json)) as AgentTimelineItem;
  return {
    seq: Number(row.seq),
    timestamp: String(row.ts),
    item,
    ...(typeof row.turn_id === "string" ? { turnId: row.turn_id } : {}),
    ...(typeof row.provider_message_id === "string"
      ? { providerMessageId: row.provider_message_id }
      : {}),
  };
}

const ROW_COLUMNS = "seq, ts, turn_id, provider_message_id, json";

/**
 * Chat timelines in pimi-timeline.db. Synchronous API: writes are buffered and committed in one
 * transaction every FLUSH_INTERVAL_MS, so recording a row costs one array push. Every read of an
 * agent goes through flush() first.
 *
 * An agent is "bound" while its in-memory timeline and its stored rows share an epoch. Writes for
 * an unbound agent, or from an older epoch, are dropped; that is what stops a late write from a
 * superseded timeline (a rewind, a rebuild) from landing in the new one.
 */
export class SqliteTimelineStore {
  private readonly logger: Logger;
  private readonly statements = new Map<string, StatementSync>();
  private readonly bound = new Map<string, BoundAgent>();
  private pending: PendingWrite[] = [];
  private pendingBytes = 0;
  private timer: NodeJS.Timeout | null = null;
  private urgentScheduled = false;
  private afterSettled: (agentId: string) => void = () => undefined;

  constructor(
    readonly database: PimiDatabase,
    logger: Logger,
  ) {
    this.logger = logger.child({
      module: "agent",
      component: "timeline-store",
    });
  }

  /** Called after an agent's rows have settled (turn closed, rows imported); the indexer hooks in. */
  setSettledListener(listener: (agentId: string) => void): void {
    this.afterSettled = listener;
  }

  private stmt(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.database.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  // ---- agent state -------------------------------------------------------------------------

  getAgent(agentId: string): StoredTimelineAgent | null {
    this.flush();
    const row = this.stmt("SELECT * FROM timeline_agents WHERE agent_id = ?").get(agentId);
    if (!row) return null;
    return {
      key: Number(row.key),
      agentId,
      epoch: String(row.epoch),
      rowFormat: Number(row.row_format),
      complete: row.complete === 1,
      openTurn: row.open_turn === 1,
      providerSubagents: row.provider_subagents === 1,
      sessionKey: typeof row.session_key === "string" ? row.session_key : null,
      fingerprint: typeof row.fingerprint === "string" ? row.fingerprint : null,
      indexedLo: Number(row.indexed_lo),
      indexedHi: Number(row.indexed_hi),
    };
  }

  isBound(agentId: string): boolean {
    return this.bound.has(agentId);
  }

  isTurnOpen(agentId: string): boolean {
    return this.bound.get(agentId)?.open === true;
  }

  getBoundEpoch(agentId: string): string | null {
    return this.bound.get(agentId)?.epoch ?? null;
  }

  /**
   * Decide whether a chat can open from its stored rows (rules 1-5; the caller handles a forced
   * reload). On success the agent is bound at its stored epoch. Returns the refusal otherwise.
   */
  openFromStore(
    agentId: string,
    expected: { sessionKey: string | null; fingerprint?: string | null },
  ): { agent: StoredTimelineAgent } | { refusal: TimelineOpenRefusal } {
    const agent = this.getAgent(agentId);
    if (!agent) return { refusal: "no_rows" };
    const refusal = this.refusalFor(agent, expected);
    if (refusal) return { refusal };
    this.bound.set(agentId, {
      key: agent.key,
      epoch: agent.epoch,
      open: false,
      failed: false,
      sessionKey: agent.sessionKey,
      providerSubagents: agent.providerSubagents,
    });
    return { agent };
  }

  private refusalFor(
    agent: StoredTimelineAgent,
    expected: { sessionKey: string | null; fingerprint?: string | null },
  ): TimelineOpenRefusal | null {
    if (!agent.complete) return "incomplete";
    if (agent.openTurn) return "open_turn";
    if (agent.sessionKey !== expected.sessionKey) return "session_changed";
    if (agent.rowFormat !== TIMELINE_ROW_FORMAT) return "row_format";
    if (agent.providerSubagents) return "provider_subagents";
    if (agent.fingerprint && expected.fingerprint && agent.fingerprint !== expected.fingerprint) {
      return "fingerprint";
    }
    return null;
  }

  /**
   * Start a timeline for an agent under `epoch`, discarding the rows of any earlier one except
   * the rows carried over a provider switch. The agent is bound afterwards.
   */
  replace(
    agentId: string,
    input: {
      epoch: string;
      sessionKey: string | null;
      complete: boolean;
      fingerprint?: string | null;
    },
  ): void {
    this.flush();
    const now = new Date().toISOString();
    const key = this.database.transaction(() => {
      const existing = this.stmt("SELECT key FROM timeline_agents WHERE agent_id = ?").get(agentId);
      let agentKey: number;
      if (existing) {
        agentKey = Number(existing.key);
        this.stmt("DELETE FROM timeline_docs WHERE agent_key = ?").run(agentKey);
        this.stmt("DELETE FROM timeline_rows WHERE agent_key = ? AND carried = 0").run(agentKey);
        this.stmt(
          `UPDATE timeline_agents SET epoch = ?, row_format = ?, complete = ?, open_turn = 0,
             provider_subagents = 0, session_key = ?, fingerprint = ?, indexed_lo = 0,
             indexed_hi = 0, updated_at = ? WHERE key = ?`,
        ).run(
          input.epoch,
          TIMELINE_ROW_FORMAT,
          input.complete ? 1 : 0,
          input.sessionKey,
          input.fingerprint ?? null,
          now,
          agentKey,
        );
      } else {
        const result = this.stmt(
          `INSERT INTO timeline_agents
             (agent_id, epoch, row_format, complete, session_key, fingerprint, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          agentId,
          input.epoch,
          TIMELINE_ROW_FORMAT,
          input.complete ? 1 : 0,
          input.sessionKey,
          input.fingerprint ?? null,
          now,
        );
        agentKey = Number(result.lastInsertRowid);
      }
      return agentKey;
    });
    this.bound.set(agentId, {
      key,
      epoch: input.epoch,
      open: false,
      failed: false,
      sessionKey: input.sessionKey,
      providerSubagents: false,
    });
  }

  /** Stop persisting an agent without touching its stored rows (internal agents, close). */
  unbind(agentId: string): void {
    this.flush();
    this.bound.delete(agentId);
  }

  /**
   * Remove an agent's timeline. With `keepCarried` the rows carried over a provider switch stay,
   * because the chat still owns them.
   */
  deleteAgent(agentId: string, options?: { keepCarried?: boolean }): void {
    this.flush();
    this.bound.delete(agentId);
    const row = this.stmt("SELECT key FROM timeline_agents WHERE agent_id = ?").get(agentId);
    if (!row) return;
    const key = Number(row.key);
    this.database.transaction(() => {
      if (options?.keepCarried) {
        this.stmt("DELETE FROM timeline_docs WHERE agent_key = ?").run(key);
        this.stmt("DELETE FROM timeline_rows WHERE agent_key = ? AND carried = 0").run(key);
        this.stmt(
          "UPDATE timeline_agents SET complete = 0, open_turn = 0, indexed_lo = 0, indexed_hi = 0 WHERE key = ?",
        ).run(key);
      } else {
        this.stmt("DELETE FROM timeline_agents WHERE key = ?").run(key);
      }
    });
  }

  /** Remove timelines of agents that no longer exist. Returns how many were removed. */
  sweepOrphans(knownAgentIds: ReadonlySet<string>): number {
    const orphans = this.stmt("SELECT agent_id FROM timeline_agents")
      .all()
      .map((row) => String(row.agent_id))
      .filter((id) => !knownAgentIds.has(id));
    for (const id of orphans) this.deleteAgent(id);
    return orphans.length;
  }

  markComplete(agentId: string, epoch: string): void {
    const state = this.bound.get(agentId);
    if (!state || state.epoch !== epoch) return;
    this.stmt("UPDATE timeline_agents SET complete = 1 WHERE key = ?").run(state.key);
  }

  markProviderSubagents(agentId: string): void {
    const state = this.bound.get(agentId);
    if (!state || state.providerSubagents) return;
    state.providerSubagents = true;
    this.stmt("UPDATE timeline_agents SET provider_subagents = 1 WHERE key = ?").run(state.key);
  }

  setFingerprint(agentId: string, fingerprint: string | null): void {
    const state = this.bound.get(agentId);
    if (!state) return;
    this.stmt("UPDATE timeline_agents SET fingerprint = ? WHERE key = ?").run(
      fingerprint,
      state.key,
    );
  }

  /**
   * Store rows a chat carried over from earlier provider switches (seq 1..n). The chat is
   * incomplete until it has been opened once under its current provider.
   */
  importCarried(agentId: string, rows: readonly AgentTimelineRow[]): void {
    this.database.transaction(() => {
      this.stmt("DELETE FROM timeline_agents WHERE agent_id = ?").run(agentId);
      const result = this.stmt(
        `INSERT INTO timeline_agents (agent_id, epoch, row_format, complete, updated_at)
         VALUES (?, ?, ?, 0, ?)`,
      ).run(agentId, randomUUID(), TIMELINE_ROW_FORMAT, new Date().toISOString());
      const key = Number(result.lastInsertRowid);
      const insert = this.stmt(
        `INSERT INTO timeline_rows
           (agent_key, seq, ts, turn_id, provider_message_id, carried, type, json)
         VALUES (?, ?, ?, ?, NULL, 1, ?, ?)`,
      );
      for (const row of rows) {
        insert.run(
          key,
          row.seq,
          row.timestamp,
          row.turnId ?? null,
          row.item.type,
          JSON.stringify(row.item),
        );
      }
    });
  }

  /** The chat switched providers: everything stored so far now belongs to the earlier ones. */
  markCarried(agentId: string, sessionKey: string | null): void {
    const state = this.bound.get(agentId);
    if (!state) return;
    this.flush();
    this.database.transaction(() => {
      this.stmt("UPDATE timeline_rows SET carried = 1 WHERE agent_key = ?").run(state.key);
      this.stmt(
        "UPDATE timeline_agents SET session_key = ?, fingerprint = NULL, updated_at = ? WHERE key = ?",
      ).run(sessionKey, new Date().toISOString(), state.key);
    });
    state.sessionKey = sessionKey;
  }

  // ---- writes -----------------------------------------------------------------------------

  /** Buffer a row (a new one, or a changed one under the same seq). No SQL runs here. */
  put(agentId: string, row: AgentTimelineRow, options?: { carried?: boolean }): void {
    const state = this.bound.get(agentId);
    if (!state) return;
    if (!state.open) this.openTurn(agentId, state);
    this.pending.push({
      agentId,
      epoch: state.epoch,
      row,
      carried: options?.carried === true,
    });
    this.pendingBytes += estimateBytes(row.item);
    if (this.pending.length >= FLUSH_URGENT_ROWS || this.pendingBytes >= FLUSH_URGENT_BYTES) {
      this.scheduleUrgentFlush();
    } else {
      this.scheduleTimer();
    }
  }

  // The flag is written before the first row of a turn: a crash, or a flush that fails, then
  // leaves open_turn = 1 behind, and the chat rebuilds from its provider instead of trusting a
  // copy that is missing rows. One small write per turn.
  private openTurn(agentId: string, state: BoundAgent): void {
    state.open = true;
    try {
      this.stmt("UPDATE timeline_agents SET open_turn = 1 WHERE key = ?").run(state.key);
    } catch (error) {
      state.failed = true;
      timelineFlushMetrics.recordFailure();
      this.logger.error({ err: error, agentId }, "Failed to mark timeline turn open");
    }
  }

  /** The turn is over: commit its rows and record the session they belong to. */
  markTurnClosed(agentId: string, sessionKey: string | null): void {
    const state = this.bound.get(agentId);
    if (!state) return;
    sessionKey ??= state.sessionKey;
    const keyChanged = sessionKey !== state.sessionKey;
    if (!state.open && !keyChanged) return;
    this.flush();
    if (state.failed) return;
    try {
      this.stmt(
        "UPDATE timeline_agents SET open_turn = 0, session_key = ?, updated_at = ? WHERE key = ?",
      ).run(sessionKey, new Date().toISOString(), state.key);
      const wasOpen = state.open;
      state.open = false;
      state.sessionKey = sessionKey;
      if (wasOpen) this.afterSettled(agentId);
    } catch (error) {
      state.failed = true;
      timelineFlushMetrics.recordFailure();
      this.logger.error({ err: error, agentId }, "Failed to mark timeline turn closed");
    }
  }

  private scheduleTimer(): void {
    if (this.timer || this.urgentScheduled) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, FLUSH_INTERVAL_MS);
    this.timer.unref?.();
  }

  private scheduleUrgentFlush(): void {
    if (this.urgentScheduled) return;
    this.urgentScheduled = true;
    setImmediate(() => {
      this.urgentScheduled = false;
      this.flushChunk();
      if (this.pending.length > 0) this.scheduleUrgentFlush();
    });
  }

  /** Commit every buffered row. Safe to call at any time; a no-op when nothing is pending. */
  flush(): void {
    while (this.pending.length > 0) this.flushChunk();
  }

  private flushChunk(): void {
    if (this.pending.length === 0) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = this.pending.splice(0, FLUSH_CHUNK_ROWS);
    this.pendingBytes = this.pending.reduce((sum, write) => sum + estimateBytes(write.row.item), 0);
    const startedAt = performance.now();
    try {
      this.database.transaction(() => this.writeBatch(batch));
      timelineFlushMetrics.recordFlush(batch.length, performance.now() - startedAt);
    } catch (error) {
      timelineFlushMetrics.recordFailure();
      this.logger.error(
        { err: error, rows: batch.length },
        "Failed to flush timeline rows; the chats involved rebuild from their provider when reopened",
      );
      for (const write of batch) {
        const state = this.bound.get(write.agentId);
        if (state) state.failed = true;
      }
    }
    if (this.pending.length > 0) this.scheduleTimer();
  }

  private writeBatch(batch: readonly PendingWrite[]): void {
    const insert = this.stmt(
      `INSERT OR REPLACE INTO timeline_rows
         (agent_key, seq, ts, turn_id, provider_message_id, carried, type, json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const write of batch) {
      const state = this.bound.get(write.agentId);
      if (!state || state.epoch !== write.epoch) continue;
      insert.run(
        state.key,
        write.row.seq,
        write.row.timestamp,
        write.row.turnId ?? null,
        write.row.providerMessageId ?? null,
        write.carried ? 1 : 0,
        write.row.item.type,
        JSON.stringify(write.row.item),
      );
    }
  }

  /**
   * Insert rows older than what is stored (an older block of a windowed history), in chunks with
   * a yield between them. Returns false, writing nothing further, when the agent's epoch moved on.
   */
  async insertRows(
    agentId: string,
    epoch: string,
    rows: readonly AgentTimelineRow[],
    options?: { carried?: boolean },
  ): Promise<boolean> {
    for (let start = 0; start < rows.length; start += FLUSH_CHUNK_ROWS) {
      const state = this.bound.get(agentId);
      if (!state || state.epoch !== epoch) return false;
      const chunk = rows.slice(start, start + FLUSH_CHUNK_ROWS);
      this.database.transaction(() =>
        this.writeBatch(
          chunk.map((row) => ({
            agentId,
            epoch,
            row,
            carried: options?.carried === true,
          })),
        ),
      );
      if (start + FLUSH_CHUNK_ROWS < rows.length) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    const state = this.bound.get(agentId);
    if (!state || state.epoch !== epoch) return false;
    if (rows.length > 0) this.afterSettled(agentId);
    return true;
  }

  // ---- reads ------------------------------------------------------------------------------

  /** Rows carried over earlier provider switches, in order. */
  readCarriedRows(agentId: string): AgentTimelineRow[] {
    const agent = this.getAgent(agentId);
    if (!agent) return [];
    return this.stmt(
      `SELECT ${ROW_COLUMNS} FROM timeline_rows WHERE agent_key = ? AND carried = 1 ORDER BY seq`,
    )
      .all(agent.key)
      .map(parseRow);
  }

  /** The newest rows, extended back to the start of a turn. */
  readTail(agentId: string, limit = TIMELINE_OPEN_ROWS): TimelineRowBlock {
    const state = this.bound.get(agentId);
    const key = state?.key ?? this.getAgent(agentId)?.key;
    if (key === undefined) return { rows: [], hasOlder: false };
    this.flush();
    const cut = this.stmt(
      "SELECT seq FROM timeline_rows WHERE agent_key = ? ORDER BY seq DESC LIMIT 1 OFFSET ?",
    ).get(key, limit - 1);
    const startSeq = cut ? this.turnStartAtOrBefore(key, Number(cut.seq), Infinity) : -Infinity;
    return this.readFrom(key, startSeq, Infinity);
  }

  /** At least `limit` rows below `beforeSeq`, extended back to the start of a turn. */
  readBefore(agentId: string, beforeSeq: number, limit: number): TimelineRowBlock {
    const key = this.bound.get(agentId)?.key ?? this.getAgent(agentId)?.key;
    if (key === undefined) return { rows: [], hasOlder: false };
    this.flush();
    const cut = this.stmt(
      "SELECT seq FROM timeline_rows WHERE agent_key = ? AND seq < ? ORDER BY seq DESC LIMIT 1 OFFSET ?",
    ).get(key, beforeSeq, limit - 1);
    const startSeq = cut ? this.turnStartAtOrBefore(key, Number(cut.seq), beforeSeq) : -Infinity;
    return this.readFrom(key, startSeq, beforeSeq);
  }

  readAll(agentId: string): AgentTimelineRow[] {
    return this.readBefore(agentId, Infinity, Number.MAX_SAFE_INTEGER).rows;
  }

  /** Lowest stored seq of an agent, or null when it has no rows. */
  minSeq(agentId: string): number | null {
    const key = this.bound.get(agentId)?.key ?? this.getAgent(agentId)?.key;
    if (key === undefined) return null;
    this.flush();
    const row = this.stmt("SELECT MIN(seq) AS seq FROM timeline_rows WHERE agent_key = ?").get(key);
    return typeof row?.seq === "number" ? row.seq : null;
  }

  private turnStartAtOrBefore(key: number, seq: number, below: number): number {
    const row = this.stmt(
      `SELECT MAX(seq) AS seq FROM timeline_rows
        WHERE agent_key = ? AND type = 'user_message' AND seq <= ? AND seq < ?`,
    ).get(key, seq, below);
    return typeof row?.seq === "number" ? row.seq : seq;
  }

  private readFrom(key: number, fromSeq: number, belowSeq: number): TimelineRowBlock {
    const rows = this.stmt(
      `SELECT ${ROW_COLUMNS} FROM timeline_rows
        WHERE agent_key = ? AND seq >= ? AND seq < ? ORDER BY seq`,
    )
      .all(key, fromSeq, belowSeq)
      .map(parseRow);
    const older = this.stmt(
      "SELECT 1 AS present FROM timeline_rows WHERE agent_key = ? AND seq < ? LIMIT 1",
    ).get(key, rows[0]?.seq ?? fromSeq);
    return { rows, hasOlder: older !== undefined };
  }

  /** Whole-database counts for the daemon log. */
  describe(): { agents: number; rows: number; bytes: number } {
    const counts = this.database.db
      .prepare(
        "SELECT (SELECT COUNT(*) FROM timeline_agents) AS agents, (SELECT COUNT(*) FROM timeline_rows) AS rows, (SELECT page_count * page_size FROM pragma_page_count, pragma_page_size) AS bytes",
      )
      .get();
    return {
      agents: Number(counts?.agents ?? 0),
      rows: Number(counts?.rows ?? 0),
      bytes: Number(counts?.bytes ?? 0),
    };
  }

  /** Commit what is buffered; the database handle itself belongs to whoever opened it. */
  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      this.flush();
    } catch (error) {
      this.logger.error({ err: error }, "Failed to flush timeline rows at shutdown");
    }
  }
}
