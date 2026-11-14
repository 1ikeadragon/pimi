import { createReadStream } from "node:fs";
import { open, opendir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Transform } from "node:stream";
import * as zlib from "node:zlib";
import type { Logger } from "pino";
import type { PimiDatabase } from "../db/pimi-db.js";
import { createClaudeParser } from "./parsers/claude.js";
import { PRICES_VERSION, requestCostUsd } from "./prices.js";
import { createCodexParser } from "./parsers/codex.js";
import type {
  UsageEventRow,
  UsageLineParser,
  UsageProvider,
  UsageSink,
  UsageToolCallRow,
} from "./types.js";

const CHUNK_BYTES = 1024 * 1024;
// A single transcript line larger than this is request-blob noise, not a usage record.
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const FLUSH_ROWS = 5000;
const INITIAL_SCAN_DELAY_MS = 5000;
const MAX_DEPTH = 6;

export interface UsageScanSummary {
  files: number;
  filesRead: number;
  bytesRead: number;
  events: number;
  durationMs: number;
}

export interface UsageScannerOptions {
  database: PimiDatabase;
  logger: Logger;
  claudeRoot?: string;
  codexRoot?: string;
  codexArchivedRoot?: string;
}

interface DiscoveredFile {
  path: string;
  provider: UsageProvider;
  size: number;
  mtimeMs: number;
}

interface Cursor {
  size: number;
  mtimeMs: number;
  offset: number;
  state: string | null;
}

export function defaultClaudeProjectsRoot(): string {
  return join(process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"), "projects");
}

function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

export function defaultCodexSessionsRoot(): string {
  return join(codexHome(), "sessions");
}

// Codex moves a thread's rollout here when the thread is archived, and Pimi archives the threads of
// chats it closes. Codex also compresses old rollouts there as `.jsonl.zst`; those are read whole
// (a compressed file has no resumable byte offset) and are rescanned only when they change.
export function defaultCodexArchivedRoot(): string {
  return join(codexHome(), "archived_sessions");
}

// Reads provider transcripts (read-only) and upserts one usage_events row per provider request.
// Each file has a byte-offset cursor, so a rescan only reads what was appended; rows are keyed by
// the provider's message id, so reading a range twice never double counts. Always on: the first
// scan after install is the backfill.
export class UsageScanner {
  private readonly database: PimiDatabase;
  private readonly logger: Logger;
  private readonly roots: { provider: UsageProvider; root: string }[];
  private running: Promise<UsageScanSummary> | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFinishedAt = 0;

  constructor(options: UsageScannerOptions) {
    this.database = options.database;
    this.logger = options.logger.child({ module: "usage-scanner" });
    this.roots = [
      { provider: "claude", root: options.claudeRoot ?? defaultClaudeProjectsRoot() },
      { provider: "codex", root: options.codexRoot ?? defaultCodexSessionsRoot() },
      { provider: "codex", root: options.codexArchivedRoot ?? defaultCodexArchivedRoot() },
    ];
  }

  get scanning(): boolean {
    return this.running !== null;
  }

  // Schedules the first scan off the startup path.
  start(): void {
    if (this.startTimer) return;
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      this.scan().catch((error) => this.logger.error({ err: error }, "usage.scan.failed"));
    }, INITIAL_SCAN_DELAY_MS);
    this.startTimer.unref();
  }

  stop(): void {
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
  }

  // Starts a scan unless one ran in the last `maxAgeMs`. Fire and forget: callers answer from the
  // rows already stored.
  refreshIfStale(maxAgeMs: number): void {
    if (this.running || Date.now() - this.lastFinishedAt < maxAgeMs) return;
    this.scan().catch((error) => this.logger.error({ err: error }, "usage.scan.failed"));
  }

  scan(): Promise<UsageScanSummary> {
    if (this.running) return this.running;
    const run = this.runScan().finally(() => {
      this.running = null;
      this.lastFinishedAt = Date.now();
    });
    this.running = run;
    return run;
  }

  private async runScan(): Promise<UsageScanSummary> {
    const startedAt = Date.now();
    this.repriceIfPricesChanged();
    const files: DiscoveredFile[] = [];
    for (const { provider, root } of this.roots) await discover(root, provider, files, 0);
    const cursors = this.loadCursors();
    const summary: UsageScanSummary = {
      files: files.length,
      filesRead: 0,
      bytesRead: 0,
      events: 0,
      durationMs: 0,
    };
    for (const file of files) {
      const cursor = cursors.get(file.path);
      if (cursor && cursor.size === file.size && cursor.mtimeMs === file.mtimeMs) continue;
      try {
        const read = await this.scanFile(file, cursor);
        summary.filesRead += 1;
        summary.bytesRead += read.bytes;
        summary.events += read.events;
      } catch (error) {
        if (isMissing(error)) continue;
        this.logger.warn({ err: error, path: file.path }, "usage.scan.file_failed");
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    this.pruneCursors(new Set(files.map((file) => file.path)));
    summary.durationMs = Date.now() - startedAt;
    this.logger.info(
      { ...summary, rssMb: Math.round(process.memoryUsage().rss / 1048576) },
      "usage.scan.done",
    );
    return summary;
  }

  // Stored costs come from the price table of the build that wrote them. Transcripts are deleted
  // after a while, so a changed table reprices the rows from their stored token counts instead of
  // rescanning.
  private repriceIfPricesChanged(): void {
    const db = this.database.db;
    const stored = db.prepare("SELECT value FROM meta WHERE key = 'usage_prices_version'").get();
    if (stored?.value === PRICES_VERSION) return;
    const rows = db
      .prepare(
        `SELECT id, provider, model, input, cache_read, cache_write, cache_write_1h, output, speed,
           us_geo FROM usage_events`,
      )
      .all();
    const update = db.prepare("UPDATE usage_events SET cost_usd = ? WHERE id = ?");
    this.database.transaction(() => {
      for (const row of rows) {
        const cost = requestCostUsd({
          provider: row.provider === "codex" ? "codex" : "claude",
          model: row.model === null ? null : String(row.model),
          input: Number(row.input),
          cacheRead: Number(row.cache_read),
          cacheWrite: Number(row.cache_write),
          cacheWrite1h: Number(row.cache_write_1h),
          output: Number(row.output),
          speed: row.speed === "fast" || row.speed === "ultrafast" ? row.speed : "standard",
          usGeo: Number(row.us_geo) === 1,
        });
        update.run(cost, Number(row.id));
      }
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('usage_prices_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(PRICES_VERSION);
    });
    this.logger.info({ rows: rows.length, version: PRICES_VERSION }, "usage.prices.repriced");
  }

  private loadCursors(): Map<string, Cursor> {
    const map = new Map<string, Cursor>();
    const rows = this.database.db
      .prepare("SELECT path, size, mtime_ms, offset, state FROM usage_scan_cursors")
      .all();
    for (const row of rows) {
      map.set(String(row.path), {
        size: Number(row.size),
        mtimeMs: Number(row.mtime_ms),
        offset: Number(row.offset),
        state: row.state === null ? null : String(row.state),
      });
    }
    return map;
  }

  private pruneCursors(present: Set<string>): void {
    const stored = this.database.db.prepare("SELECT path FROM usage_scan_cursors").all();
    const gone = stored.map((row) => String(row.path)).filter((path) => !present.has(path));
    if (gone.length === 0) return;
    const remove = this.database.db.prepare("DELETE FROM usage_scan_cursors WHERE path = ?");
    this.database.transaction(() => {
      for (const path of gone) remove.run(path);
    });
  }

  private async scanFile(
    file: DiscoveredFile,
    cursor: Cursor | undefined,
  ): Promise<{ bytes: number; events: number }> {
    const compressed = file.path.endsWith(".zst");
    const resumable = !compressed && cursor !== undefined && cursor.offset <= file.size;
    const startOffset = resumable ? cursor.offset : 0;
    let parserState: unknown = null;
    if (resumable && cursor.state) {
      try {
        parserState = JSON.parse(cursor.state);
      } catch {
        parserState = null;
      }
    }
    const parser: UsageLineParser =
      file.provider === "claude"
        ? createClaudeParser(file.path)
        : createCodexParser(file.path, parserState);

    const db = this.database.db;
    const insertEvent = db.prepare(
      `INSERT INTO usage_events (ts, provider, model, session_id, subagent_id, parent_session_id,
         cwd, input, cache_read, cache_write, cache_write_1h, output, reasoning, total, speed,
         us_geo, cost_usd, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(dedupe_key) DO UPDATE SET
         model = excluded.model, input = excluded.input, cache_read = excluded.cache_read,
         cache_write = excluded.cache_write, cache_write_1h = excluded.cache_write_1h,
         output = excluded.output, reasoning = excluded.reasoning, total = excluded.total,
         speed = excluded.speed, us_geo = excluded.us_geo, cost_usd = excluded.cost_usd
       WHERE excluded.total >= usage_events.total`,
    );
    const insertTool = db.prepare(
      "INSERT OR IGNORE INTO usage_tool_calls (call_id, ts, provider, name) VALUES (?, ?, ?, ?)",
    );
    let events: UsageEventRow[] = [];
    let tools: UsageToolCallRow[] = [];
    let eventCount = 0;
    const sink: UsageSink = {
      event: (row) => {
        events.push(row);
        eventCount += 1;
      },
      toolCall: (row) => tools.push(row),
    };
    const flush = (cursorUpdate: { offset: number } | null): void => {
      if (events.length === 0 && tools.length === 0 && cursorUpdate === null) return;
      const batchEvents = events;
      const batchTools = tools;
      events = [];
      tools = [];
      this.database.transaction(() => {
        for (const row of batchEvents) {
          insertEvent.run(
            row.ts,
            row.provider,
            row.model,
            row.sessionId,
            row.subagentId,
            row.parentSessionId,
            row.cwd,
            row.input,
            row.cacheRead,
            row.cacheWrite,
            row.cacheWrite1h,
            row.output,
            row.reasoning,
            row.total,
            row.speed,
            row.usGeo ? 1 : 0,
            row.costUsd,
            row.dedupeKey,
          );
        }
        for (const row of batchTools) insertTool.run(row.callId, row.ts, row.provider, row.name);
        if (cursorUpdate !== null) {
          const state = parser.state();
          db.prepare(
            `INSERT INTO usage_scan_cursors (path, size, mtime_ms, offset, state)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms,
               offset = excluded.offset, state = excluded.state`,
          ).run(
            file.path,
            Math.max(file.size, cursorUpdate.offset),
            file.mtimeMs,
            cursorUpdate.offset,
            state === null ? null : JSON.stringify(state),
          );
        }
      });
    };

    let consumed = startOffset;
    let bytes = 0;
    const chunks = compressed ? zstdChunks(file.path) : fileChunks(file.path, startOffset);
    for await (const item of readLines(chunks, startOffset)) {
      bytes = item.bytesRead;
      consumed = item.end;
      if (item.line) handleLine(item.line, parser, sink);
      if (events.length >= FLUSH_ROWS) flush(null);
    }
    parser.finish?.(sink);
    // A compressed file is always read from its start, so its cursor only records that it was read.
    flush({ offset: compressed ? file.size : consumed });
    return { bytes, events: eventCount };
  }
}

interface LineItem {
  // Null for a line that exceeded MAX_LINE_BYTES and was dropped.
  line: Buffer | null;
  // Byte offset just after this line's newline.
  end: number;
  bytesRead: number;
}

async function* fileChunks(path: string, startOffset: number): AsyncGenerator<Buffer> {
  const handle = await open(path, "r");
  try {
    let position = startOffset;
    for (;;) {
      const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
      const read = await handle.read(chunk, 0, CHUNK_BYTES, position);
      if (read.bytesRead === 0) return;
      position += read.bytesRead;
      yield chunk.subarray(0, read.bytesRead);
    }
  } finally {
    await handle.close();
  }
}

// Node 22.15+ ships zstd in zlib; the pinned @types/node (20) does not declare it yet.
const createZstdDecompress = (zlib as unknown as { createZstdDecompress(): Transform })
  .createZstdDecompress;

async function* zstdChunks(path: string): AsyncGenerator<Buffer> {
  const stream = createReadStream(path).pipe(createZstdDecompress());
  for await (const chunk of stream) yield chunk as Buffer;
}

// Splits a byte stream into complete lines. A final line without a newline is not yielded, so for
// a plain file its bytes are read again once it is finished.
async function* readLines(
  chunks: AsyncIterable<Buffer>,
  startOffset: number,
): AsyncGenerator<LineItem> {
  let consumed = startOffset;
  let bytesRead = 0;
  let parts: Buffer[] = [];
  let partsBytes = 0;
  let skipping = false;
  for await (const view of chunks) {
    bytesRead += view.length;
    let pos = 0;
    let newline = view.indexOf(10, pos);
    while (newline !== -1) {
      const piece = view.subarray(pos, newline);
      consumed += partsBytes + piece.length + 1;
      let line: Buffer | null = null;
      if (!skipping) line = parts.length > 0 ? Buffer.concat([...parts, piece]) : piece;
      skipping = false;
      parts = [];
      partsBytes = 0;
      yield { line, end: consumed, bytesRead };
      pos = newline + 1;
      newline = view.indexOf(10, pos);
    }
    if (pos < view.length) {
      partsBytes += view.length - pos;
      if (partsBytes > MAX_LINE_BYTES) skipping = true;
      if (skipping) parts = [];
      else parts.push(view.subarray(pos));
    }
  }
}

function handleLine(line: Buffer, parser: UsageLineParser, sink: UsageSink): void {
  if (line.length === 0) return;
  let matched = false;
  for (const needle of parser.needles) {
    if (line.includes(needle)) {
      matched = true;
      break;
    }
  }
  if (!matched) return;
  const end = line[line.length - 1] === 13 ? line.length - 1 : line.length;
  parser.handle(line.toString("utf8", 0, end), sink);
}

function isTranscript(name: string, provider: UsageProvider): boolean {
  return name.endsWith(".jsonl") || (provider === "codex" && name.endsWith(".jsonl.zst"));
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

async function discover(
  dir: string,
  provider: UsageProvider,
  out: DiscoveredFile[],
  depth: number,
): Promise<void> {
  if (depth > MAX_DEPTH) return;
  let handle: Awaited<ReturnType<typeof opendir>>;
  try {
    handle = await opendir(dir);
  } catch {
    return;
  }
  for await (const entry of handle) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Claude keeps per-project "memory" notes next to transcripts; they hold no usage.
      if (entry.name === "memory" || entry.name === "tool-results") continue;
      await discover(path, provider, out, depth + 1);
    } else if (entry.isFile() && isTranscript(entry.name, provider)) {
      try {
        const info = await stat(path);
        out.push({ path, provider, size: info.size, mtimeMs: Math.floor(info.mtimeMs) });
      } catch {
        // File vanished between listing and stat.
      }
    }
  }
}
