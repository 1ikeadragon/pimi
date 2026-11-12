import type { Logger } from "pino";
import type { AgentTimelineRow } from "../agent-timeline-store-types.js";
import type { SqliteTimelineStore } from "../sqlite-timeline-store.js";
import { buildTimelineDocuments } from "./documents.js";

const PAGE_ROWS = 2000;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function parseRows(rows: Record<string, unknown>[]): AgentTimelineRow[] {
  return rows.map((row) => ({
    seq: Number(row.seq),
    timestamp: String(row.ts),
    item: JSON.parse(String(row.json)),
    ...(typeof row.turn_id === "string" ? { turnId: row.turn_id } : {}),
    ...(typeof row.provider_message_id === "string"
      ? { providerMessageId: row.provider_message_id }
      : {}),
  }));
}

/**
 * Keeps timeline_docs (and through it the FTS index) in step with timeline_rows. Each agent has
 * an indexed span [indexed_lo, indexed_hi] of seqs; a pass extends it upwards over rows added
 * since (only once the turn is closed, so a message still streaming is not split) and downwards
 * over older blocks that landed below it. Pages are cut at turn starts and committed one
 * transaction each, with a yield between them, so the daemon stays responsive.
 */
export class TimelineIndexer {
  private readonly running = new Set<string>();
  private readonly dirty = new Set<string>();
  private readonly logger: Logger;

  constructor(
    private readonly store: SqliteTimelineStore,
    logger: Logger,
  ) {
    this.logger = logger.child({ module: "agent", component: "timeline-indexer" });
  }

  notify(agentId: string): void {
    if (this.running.has(agentId)) {
      this.dirty.add(agentId);
      return;
    }
    this.running.add(agentId);
    void this.run(agentId);
  }

  /** Resolves once every pass started so far has finished. */
  async idle(): Promise<void> {
    while (this.running.size > 0) await yieldToEventLoop();
  }

  private async run(agentId: string): Promise<void> {
    try {
      do {
        this.dirty.delete(agentId);
        await this.indexAgent(agentId);
      } while (this.dirty.has(agentId));
    } catch (error) {
      this.logger.error({ err: error, agentId }, "Failed to index chat timeline");
    } finally {
      this.running.delete(agentId);
      this.dirty.delete(agentId);
    }
  }

  private async indexAgent(agentId: string): Promise<void> {
    const store = this.store;
    for (;;) {
      const agent = store.getAgent(agentId);
      if (!agent) return;
      const page = store.isTurnOpen(agentId)
        ? this.nextOlderPage(agent.key, agent.indexedLo)
        : (this.nextNewerPage(agent.key, agent.indexedHi) ??
          this.nextOlderPage(agent.key, agent.indexedLo));
      if (!page) return;
      const committed = this.commit(agent.key, agent.epoch, page);
      if (!committed) return;
      await yieldToEventLoop();
    }
  }

  private nextNewerPage(key: number, hi: number): AgentTimelineRow[] | null {
    const db = this.store.database.db;
    const rows = parseRows(
      db
        .prepare(
          `SELECT seq, ts, turn_id, provider_message_id, json FROM timeline_rows
            WHERE agent_key = ? AND seq > ? ORDER BY seq LIMIT ?`,
        )
        .all(key, hi, PAGE_ROWS),
    );
    if (rows.length === 0) return null;
    if (rows.length < PAGE_ROWS) return rows;
    // A full page: stop before the last turn start so a turn is not cut in half.
    const cut = rows.findLastIndex((row, index) => index > 0 && row.item.type === "user_message");
    return cut > 0 ? rows.slice(0, cut) : rows;
  }

  private nextOlderPage(key: number, lo: number): AgentTimelineRow[] | null {
    if (lo === 0) return null;
    const db = this.store.database.db;
    const cut = db
      .prepare(
        "SELECT seq FROM timeline_rows WHERE agent_key = ? AND seq < ? ORDER BY seq DESC LIMIT 1 OFFSET ?",
      )
      .get(key, lo, PAGE_ROWS - 1);
    let start = -Infinity;
    if (cut) {
      const turn = db
        .prepare(
          `SELECT MAX(seq) AS seq FROM timeline_rows
            WHERE agent_key = ? AND type = 'user_message' AND seq <= ?`,
        )
        .get(key, Number(cut.seq));
      start = typeof turn?.seq === "number" ? turn.seq : Number(cut.seq);
    }
    const rows = parseRows(
      db
        .prepare(
          `SELECT seq, ts, turn_id, provider_message_id, json FROM timeline_rows
            WHERE agent_key = ? AND seq >= ? AND seq < ? ORDER BY seq`,
        )
        .all(key, start, lo),
    );
    return rows.length > 0 ? rows : null;
  }

  /** Write one page's documents and move the span. False when the agent changed under the pass. */
  private commit(key: number, epoch: string, rows: AgentTimelineRow[]): boolean {
    const documents = buildTimelineDocuments(rows);
    const first = rows[0]!.seq;
    const last = rows[rows.length - 1]!.seq;
    return this.store.database.transaction(() => {
      const db = this.store.database.db;
      const current = db
        .prepare("SELECT epoch, indexed_lo, indexed_hi FROM timeline_agents WHERE key = ?")
        .get(key);
      if (!current || current.epoch !== epoch) return false;
      db.prepare("DELETE FROM timeline_docs WHERE agent_key = ? AND seq_start BETWEEN ? AND ?").run(
        key,
        first,
        last,
      );
      const insert = db.prepare(
        `INSERT INTO timeline_docs (agent_key, seq_start, seq_end, kind, ts, text)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (agent_key, seq_start) DO UPDATE SET
           seq_end = excluded.seq_end, kind = excluded.kind, ts = excluded.ts, text = excluded.text`,
      );
      for (const document of documents) {
        insert.run(
          key,
          document.seqStart,
          document.seqEnd,
          document.kind,
          document.timestamp,
          document.text,
        );
      }
      const lo = Number(current.indexed_lo);
      const hi = Number(current.indexed_hi);
      const nextLo = lo === 0 ? first : Math.min(lo, first);
      const nextHi = Math.max(hi, last);
      db.prepare("UPDATE timeline_agents SET indexed_lo = ?, indexed_hi = ? WHERE key = ?").run(
        nextLo,
        nextHi,
        key,
      );
      return true;
    });
  }
}
