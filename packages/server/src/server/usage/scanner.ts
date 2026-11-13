import { open, opendir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import type { PimiDatabase } from "../db/pimi-db.js";
import { createClaudeParser } from "./parsers/claude.js";
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

export function defaultCodexSessionsRoot(): string {
  return join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "sessions");
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
    const resumable = cursor !== undefined && cursor.offset <= file.size;
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
      file.provider === "claude" ? createClaudeParser(file.path) : createCodexParser(parserState);

    const db = this.database.db;
    const insertEvent = db.prepare(
      `INSERT INTO usage_events (ts, provider, model, session_id, subagent_id, parent_session_id,
         cwd, input, cache_read, cache_write, output, reasoning, total, cost_usd, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(dedupe_key) DO UPDATE SET
         model = excluded.model, input = excluded.input, cache_read = excluded.cache_read,
         cache_write = excluded.cache_write, output = excluded.output,
         reasoning = excluded.reasoning, total = excluded.total, cost_usd = excluded.cost_usd
       WHERE excluded.total > usage_events.total`,
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
            row.output,
            row.reasoning,
            row.total,
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

    const handle = await open(file.path, "r");
    let consumed = startOffset;
    let bytes = 0;
    try {
      for await (const item of readLines(handle, startOffset)) {
        bytes = item.bytesRead;
        consumed = item.end;
        if (item.line) handleLine(item.line, parser, sink);
        if (events.length >= FLUSH_ROWS) flush(null);
      }
    } finally {
      await handle.close();
    }
    flush({ offset: consumed });
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

// Splits a file into complete lines starting at `startOffset`, one 1 MiB read at a time. A final
// line without a newline is not yielded, so its bytes are read again once it is finished.
async function* readLines(
  handle: Awaited<ReturnType<typeof open>>,
  startOffset: number,
): AsyncGenerator<LineItem> {
  let position = startOffset;
  let consumed = startOffset;
  let bytesRead = 0;
  let parts: Buffer[] = [];
  let partsBytes = 0;
  let skipping = false;
  for (;;) {
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
    const read = await handle.read(chunk, 0, CHUNK_BYTES, position);
    if (read.bytesRead === 0) return;
    position += read.bytesRead;
    bytesRead += read.bytesRead;
    const view = chunk.subarray(0, read.bytesRead);
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
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      try {
        const info = await stat(path);
        out.push({ path, provider, size: info.size, mtimeMs: Math.floor(info.mtimeMs) });
      } catch {
        // File vanished between listing and stat.
      }
    }
  }
}
