import { DatabaseSync } from "node:sqlite";
import { requestCostUsd } from "../prices.js";
import { toNumber, type UsageEventRow, type UsageSink } from "../types.js";

const BATCH_ROWS = 2000;
const MAX_SESSION_DEPTH = 16;

interface SessionInfo {
  directory: string | null;
  parentId: string | null;
}

function emitTools(rows: Record<string, unknown>[], ts: number, sink: UsageSink): void {
  for (const row of rows) {
    if (typeof row.id !== "string" || typeof row.name !== "string") continue;
    sink.toolCall({ callId: row.id, ts, provider: "opencode", name: row.name });
  }
}

// OpenCode 2.x keeps every session in one SQLite file (<data dir>/opencode/opencode.db). An
// assistant row in `session_message` carries that response's `tokens`, `model` and the `tool`
// blocks it called; `session_v2` carries the working directory and the parent of a subagent
// session. Returns the highest `time_updated` read, to pass back as `afterUpdated`: a response is
// rewritten (and its time_updated moves) while it streams and when it completes, so everything
// changed since the last read comes back (`onBatch` fires after each batch so the caller can
// persist rows and the cursor in bounded chunks), and a row read twice upserts onto the same dedupe key.
export function readOpenCodeUsage(
  dbPath: string,
  afterUpdated: number,
  sink: UsageSink,
  onBatch: (lastUpdated: number) => void,
): { lastUpdated: number; events: number } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    const rows = db.prepare(
      `SELECT id, session_id, time_created, time_updated,
         json_extract(data, '$.model.id') AS model, json_extract(data, '$.cost') AS cost,
         json_extract(data, '$.tokens.input') AS input,
         json_extract(data, '$.tokens.output') AS output,
         json_extract(data, '$.tokens.reasoning') AS reasoning,
         json_extract(data, '$.tokens.cache.read') AS cache_read,
         json_extract(data, '$.tokens.cache.write') AS cache_write
       FROM session_message
       WHERE type = 'assistant' AND (time_updated, id) > (?, ?)
       ORDER BY time_updated, id LIMIT ${BATCH_ROWS}`,
    );
    const tools = db.prepare(
      `SELECT json_extract(c.value, '$.id') AS id, json_extract(c.value, '$.name') AS name
       FROM session_message m, json_each(m.data, '$.content') c
       WHERE m.id = ? AND json_extract(c.value, '$.type') = 'tool'`,
    );
    const sessionRow = db.prepare("SELECT directory, parent_id FROM session_v2 WHERE id = ?");
    const sessions = new Map<string, SessionInfo | null>();
    const sessionOf = (id: string): SessionInfo | null => {
      if (sessions.has(id)) return sessions.get(id) ?? null;
      const row = sessionRow.get(id);
      const info: SessionInfo | null = row
        ? {
            directory: typeof row.directory === "string" ? row.directory : null,
            parentId: typeof row.parent_id === "string" ? row.parent_id : null,
          }
        : null;
      sessions.set(id, info);
      return info;
    };
    // The chat a subagent session belongs to is the root of its parent chain.
    const rootOf = (id: string): string | null => {
      let current = id;
      for (let depth = 0; depth < MAX_SESSION_DEPTH; depth += 1) {
        const parent = sessionOf(current)?.parentId ?? null;
        if (parent === null) return current === id ? null : current;
        current = parent;
      }
      return current;
    };

    let lastUpdated = afterUpdated;
    let lastId = "";
    let events = 0;
    for (;;) {
      const batch = rows.all(lastUpdated, lastId);
      for (const row of batch) {
        const ts = Number(row.time_created);
        const sessionId = String(row.session_id);
        const messageId = String(row.id);
        lastUpdated = Number(row.time_updated);
        lastId = messageId;
        emitTools(tools.all(messageId), ts, sink);
        const input = toNumber(row.input);
        const cacheRead = toNumber(row.cache_read);
        const cacheWrite = toNumber(row.cache_write);
        const reasoning = toNumber(row.reasoning);
        // OpenCode reports reasoning apart from output; the ledger's `output` includes it.
        const output = toNumber(row.output) + reasoning;
        const total = input + cacheRead + cacheWrite + output;
        if (total === 0) continue;
        const model = typeof row.model === "string" ? row.model : null;
        const event: UsageEventRow = {
          ts,
          provider: "opencode",
          model,
          sessionId,
          subagentId: null,
          parentSessionId: rootOf(sessionId),
          cwd: sessionOf(sessionId)?.directory ?? null,
          input,
          cacheRead,
          cacheWrite,
          cacheWrite1h: 0,
          output,
          reasoning,
          total,
          speed: "standard",
          usGeo: false,
          // OpenCode records the cost of each response itself (exact for paid and free models);
          // the price table covers only a response that lacks one.
          costUsd:
            typeof row.cost === "number" && Number.isFinite(row.cost) && row.cost >= 0
              ? row.cost
              : requestCostUsd({
                  provider: "opencode",
                  model,
                  input,
                  cacheRead,
                  cacheWrite,
                  cacheWrite1h: 0,
                  output,
                  speed: "standard",
                  usGeo: false,
                }),
          dedupeKey: `opencode:${messageId}`,
        };
        sink.event(event);
        events += 1;
      }
      if (batch.length > 0) onBatch(lastUpdated);
      if (batch.length < BATCH_ROWS) break;
    }
    return { lastUpdated, events };
  } finally {
    db.close();
  }
}
