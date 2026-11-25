import { createReadStream } from "node:fs";
import { open, opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve as absolutePath, sep } from "node:path";
import type { Transform } from "node:stream";
import * as zlib from "node:zlib";
import type { Logger } from "pino";
import type { UsageScanReport } from "@pimi/protocol/messages";
import type { PimiDatabase } from "../db/pimi-db.js";
import { createClaudeParser } from "./parsers/claude.js";
import { PRICES_VERSION, requestCostUsd } from "./prices.js";
import { createCodexParser } from "./parsers/codex.js";
import { readOpenCodeUsage } from "./parsers/opencode.js";
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

// ---
// The scan report lists failed files so a gap in the numbers has a named cause. A user whose
// rollouts are all unreadable (a permission change on the config directory) has thousands of
// failures; the first 20 name the cause and the rest add nothing, so the rest are only counted.
const MAX_REPORTED_FAILED_FILES = 20;

export type UsageScanSummary = Omit<UsageScanReport, "finishedAt" | "error">;

export interface UsageScannerOptions {
  database: PimiDatabase;
  logger: Logger;
  claudeRoot?: string;
  codexRoot?: string;
  codexArchivedRoot?: string;
  openCodeDb?: string;
  // Config directories of the extra Claude and Codex logins this daemon launches with (a provider
  // profile's CLAUDE_CONFIG_DIR or CODEX_HOME). Called on every scan: profiles come and go while
  // the daemon runs.
  configDirs?: () => ProviderConfigDir[];
}

export interface ProviderConfigDir {
  provider: "claude" | "codex";
  dir: string;
}

type UsageScanRoot = UsageScanReport["roots"][number];
type UsageScanFailure = UsageScanReport["failedFiles"][number];

interface FileScanResult {
  bytes: number;
  events: number;
  malformedLines: number;
  oversizeLines: number;
  forkCopiesSuppressed: number;
}

interface ScanRoot {
  provider: UsageProvider;
  root: string;
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

// OpenCode keeps all sessions in one SQLite file under its XDG data dir.
export function defaultOpenCodeDbPath(): string {
  const dataHome = process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  return join(dataHome, "opencode", "opencode.db");
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
  private readonly defaultRoots: ScanRoot[];
  private readonly configDirs: () => ProviderConfigDir[];
  private readonly openCodeDb: string;
  private running: Promise<UsageScanSummary> | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFinishedAt = 0;
  private report: UsageScanReport | null = null;

  constructor(options: UsageScannerOptions) {
    this.database = options.database;
    this.logger = options.logger.child({ module: "usage-scanner" });
    this.configDirs = options.configDirs ?? (() => []);
    this.defaultRoots = [
      { provider: "claude", root: options.claudeRoot ?? defaultClaudeProjectsRoot() },
      { provider: "codex", root: options.codexRoot ?? defaultCodexSessionsRoot() },
      { provider: "codex", root: options.codexArchivedRoot ?? defaultCodexArchivedRoot() },
    ];
    this.openCodeDb = options.openCodeDb ?? defaultOpenCodeDbPath();
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

  // What the most recent scan found, or why it failed. Null until the first scan ends.
  get lastReport(): UsageScanReport | null {
    return this.report;
  }

  scan(): Promise<UsageScanSummary> {
    if (this.running) return this.running;
    const run = this.runScan()
      .then(
        (summary) => {
          this.report = { ...summary, finishedAt: Date.now(), error: null };
          return summary;
        },
        (error: unknown) => {
          this.report = {
            ...emptySummary(),
            finishedAt: Date.now(),
            error: error instanceof Error ? error.message : String(error),
          };
          throw error;
        },
      )
      .finally(() => {
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
    const failures: UsageScanFailure[] = [];
    const roots: UsageScanSummary["roots"] = [];
    for (const { provider, root } of await this.resolveRoots()) {
      const status = await discoverRoot({ root, provider, files, failures });
      if (status.status === "unreadable") {
        this.logger.warn({ path: root, err: status.error }, "usage.scan.root_unreadable");
      }
      roots.push(status);
    }
    const cursors = this.loadCursors();
    const summary: UsageScanSummary = {
      ...emptySummary(),
      files: files.length,
      roots,
    };
    for (const file of files) {
      const cursor = cursors.get(file.path);
      if (cursor && cursor.size === file.size && cursor.mtimeMs === file.mtimeMs) continue;
      try {
        const read = await this.scanFile(file, cursor);
        summary.filesRead += 1;
        summary.bytesRead += read.bytes;
        summary.events += read.events;
        summary.malformedLines += read.malformedLines;
        summary.oversizeLines += read.oversizeLines;
        summary.forkCopiesSuppressed += read.forkCopiesSuppressed;
      } catch (error) {
        if (isMissing(error)) continue;
        this.logger.warn({ err: error, path: file.path }, "usage.scan.file_failed");
        failures.push({ path: file.path, error: errorMessage(error) });
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    try {
      summary.events += await this.scanOpenCode();
    } catch (error) {
      this.logger.warn({ err: error, path: this.openCodeDb }, "usage.scan.file_failed");
      failures.push({ path: this.openCodeDb, error: errorMessage(error) });
    }
    const unreadable = roots
      .filter((root) => root.status === "unreadable")
      .map((root) => root.path);
    this.pruneCursors(new Set([...files.map((file) => file.path), this.openCodeDb]), unreadable);
    summary.failedFiles = failures.slice(0, MAX_REPORTED_FAILED_FILES);
    summary.failedFilesDropped = failures.length - summary.failedFiles.length;
    summary.durationMs = Date.now() - startedAt;
    this.logger.info(
      {
        ...summary,
        // The report carries these; the log line keeps counts so one line stays one line.
        roots: roots.length,
        failedFiles: failures.length,
        rssMb: Math.round(process.memoryUsage().rss / 1048576),
      },
      "usage.scan.done",
    );
    return summary;
  }

  // The default roots plus the roots of every extra login, each once: two profiles can point at
  // one directory, and a symlinked root would otherwise be scanned twice under different paths.
  private async resolveRoots(): Promise<ScanRoot[]> {
    const candidates = [...this.defaultRoots];
    for (const { provider, dir } of this.configDirs()) {
      if (provider === "claude") {
        candidates.push({ provider, root: join(dir, "projects") });
      } else {
        candidates.push({ provider, root: join(dir, "sessions") });
        candidates.push({ provider, root: join(dir, "archived_sessions") });
      }
    }
    const seen = new Set<string>();
    const roots: ScanRoot[] = [];
    for (const candidate of candidates) {
      const root = absolutePath(candidate.root);
      // A root that does not exist has no real path yet; its own path still identifies it.
      const key = await realpath(root).catch(() => root);
      if (seen.has(key)) continue;
      seen.add(key);
      roots.push({ provider: candidate.provider, root });
    }
    return roots;
  }

  // Stored costs come from the price table of the build that wrote them. Transcripts are deleted
  // after a while, so a changed table reprices the rows from their stored token counts instead of
  // rescanning. OpenCode rows keep the cost OpenCode recorded, so they are not repriced.
  private repriceIfPricesChanged(): void {
    const db = this.database.db;
    const stored = db.prepare("SELECT value FROM meta WHERE key = 'usage_prices_version'").get();
    if (stored?.value === PRICES_VERSION) return;
    const rows = db
      .prepare(
        `SELECT id, provider, model, input, cache_read, cache_write, cache_write_1h, output, speed,
           us_geo FROM usage_events
         WHERE provider != 'opencode'`,
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

  // Cursors of files that no longer exist are dropped. A root that could not be listed keeps its
  // cursors: its files are not gone, only unseen, and dropping them would read them all again.
  private pruneCursors(present: Set<string>, unreadableRoots: readonly string[]): void {
    const stored = this.database.db.prepare("SELECT path FROM usage_scan_cursors").all();
    const gone = stored
      .map((row) => String(row.path))
      .filter(
        (path) =>
          !present.has(path) && !unreadableRoots.some((root) => path.startsWith(`${root}${sep}`)),
      );
    if (gone.length === 0) return;
    const remove = this.database.db.prepare("DELETE FROM usage_scan_cursors WHERE path = ?");
    this.database.transaction(() => {
      for (const path of gone) remove.run(path);
    });
  }

  private async scanFile(
    file: DiscoveredFile,
    cursor: Cursor | undefined,
  ): Promise<FileScanResult> {
    const compressed = file.path.endsWith(".zst");
    let resumeFrom =
      !compressed && cursor !== undefined && cursor.offset <= file.size ? cursor : null;
    let parserState: unknown = null;
    if (resumeFrom?.state) {
      try {
        parserState = JSON.parse(resumeFrom.state);
      } catch (error) {
        // Continuing mid-file without the parser's state would misattribute what follows. Rows are
        // keyed, so reading the file again from its start is safe.
        this.logger.warn({ err: error, path: file.path }, "usage.scan.cursor_state_unreadable");
        resumeFrom = null;
      }
    }
    const startOffset = resumeFrom?.offset ?? 0;
    const parser: UsageLineParser =
      file.provider === "claude"
        ? createClaudeParser(file.path)
        : createCodexParser(file.path, parserState);

    const writer = this.createWriter();
    let consumed = startOffset;
    let bytes = 0;
    let oversizeLines = 0;
    const chunks = compressed ? zstdChunks(file.path) : fileChunks(file.path, startOffset);
    for await (const item of readLines(chunks, startOffset)) {
      bytes = item.bytesRead;
      consumed = item.end;
      if (item.line === null) oversizeLines += 1;
      else handleLine(item.line, parser, writer.sink);
      if (writer.pending() >= FLUSH_ROWS) writer.flush(null);
    }
    parser.finish?.(writer.sink);
    // A compressed file is always read from its start, so its cursor only records that it was read.
    writer.flush({
      path: file.path,
      size: Math.max(file.size, compressed ? file.size : consumed),
      mtimeMs: file.mtimeMs,
      offset: compressed ? file.size : consumed,
      state: parser.state(),
    });
    const { malformedLines, forkCopiesSuppressed } = parser.diagnostics();
    return {
      bytes,
      events: writer.eventCount(),
      malformedLines,
      oversizeLines,
      forkCopiesSuppressed,
    };
  }

  // Reads OpenCode's SQLite store from the highest time_updated already read. The cursor row is
  // keyed by the database path; its size and mtime cover the database and its WAL, so an idle
  // OpenCode costs one stat per file and no query.
  private async scanOpenCode(): Promise<number> {
    const dbPath = this.openCodeDb;
    let size = 0;
    let mtimeMs = 0;
    try {
      for (const path of [dbPath, `${dbPath}-wal`]) {
        const info = await stat(path).catch((error) => {
          if (path !== dbPath && isMissing(error)) return null;
          throw error;
        });
        if (info === null) continue;
        size += info.size;
        mtimeMs = Math.max(mtimeMs, Math.floor(info.mtimeMs));
      }
    } catch (error) {
      if (isMissing(error)) return 0;
      throw error;
    }
    const cursor = this.loadCursors().get(dbPath);
    if (cursor && cursor.size === size && cursor.mtimeMs === mtimeMs) return 0;
    const writer = this.createWriter();
    const start = cursor?.offset ?? 0;
    const read = readOpenCodeUsage(dbPath, start, writer.sink);
    for (;;) {
      const step = read.next();
      if (!step.done) {
        writer.flush({ path: dbPath, size: 0, mtimeMs: 0, offset: step.value, state: null });
        // Each batch is synchronous SQLite work; let the daemon serve requests in between.
        await new Promise((resolve) => setImmediate(resolve));
        continue;
      }
      // Busy: leave the cursor as it was so the next scan retries. Unsupported (OpenCode 1.x):
      // remember the file's size so it costs one stat until it changes (e.g. an upgrade).
      if (step.value === "busy") return writer.eventCount();
      const offset = step.value === "unsupported" ? start : step.value.lastUpdated;
      writer.flush({ path: dbPath, size, mtimeMs, offset, state: null });
      return writer.eventCount();
    }
  }

  // Buffers parsed rows and writes them, with the source's cursor, in one transaction per flush.
  private createWriter(): UsageWriter {
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
    return {
      sink: {
        event: (row) => {
          events.push(row);
          eventCount += 1;
        },
        toolCall: (row) => tools.push(row),
      },
      pending: () => events.length,
      eventCount: () => eventCount,
      flush: (cursorUpdate) => {
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
            db.prepare(
              `INSERT INTO usage_scan_cursors (path, size, mtime_ms, offset, state)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms,
                 offset = excluded.offset, state = excluded.state`,
            ).run(
              cursorUpdate.path,
              cursorUpdate.size,
              cursorUpdate.mtimeMs,
              cursorUpdate.offset,
              cursorUpdate.state === null ? null : JSON.stringify(cursorUpdate.state),
            );
          }
        });
      },
    };
  }
}

interface CursorWrite {
  path: string;
  size: number;
  mtimeMs: number;
  offset: number;
  state: unknown;
}

interface UsageWriter {
  sink: UsageSink;
  pending(): number;
  eventCount(): number;
  flush(cursor: CursorWrite | null): void;
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

interface DiscoverInput {
  root: string;
  provider: UsageProvider;
  files: DiscoveredFile[];
  failures: UsageScanFailure[];
}

// Lists a root's transcripts. A root that does not exist is normal (no login of that kind); one
// that exists but cannot be listed is reported, because its usage is then missing from the ledger.
async function discoverRoot(input: DiscoverInput): Promise<UsageScanRoot> {
  const { root, provider } = input;
  try {
    await discover(input, root, 0);
    return { path: root, provider, status: "ok", error: null };
  } catch (error) {
    if (isMissing(error)) return { path: root, provider, status: "missing", error: null };
    return { path: root, provider, status: "unreadable", error: errorMessage(error) };
  }
}

// Failures below the root are recorded and the walk continues, so one unreadable project folder
// does not hide the rest. The root itself throws to discoverRoot.
async function discover(input: DiscoverInput, dir: string, depth: number): Promise<void> {
  const { provider, failures } = input;
  if (depth > MAX_DEPTH) {
    failures.push({ path: dir, error: `Nested deeper than ${MAX_DEPTH} levels; not read` });
    return;
  }
  try {
    for await (const entry of await opendir(dir)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Claude keeps per-project "memory" notes next to transcripts; they hold no usage.
        if (entry.name === "memory" || entry.name === "tool-results") continue;
        await discover(input, path, depth + 1);
      } else if (entry.isFile() && isTranscript(entry.name, provider)) {
        await collectFile(input, path);
      }
    }
  } catch (error) {
    if (depth === 0) throw error;
    if (!isMissing(error)) failures.push({ path: dir, error: errorMessage(error) });
  }
}

async function collectFile(input: DiscoverInput, path: string): Promise<void> {
  try {
    const info = await stat(path);
    input.files.push({
      path,
      provider: input.provider,
      size: info.size,
      mtimeMs: Math.floor(info.mtimeMs),
    });
  } catch (error) {
    // A file that vanished between listing and stat is not a failure.
    if (!isMissing(error)) input.failures.push({ path, error: errorMessage(error) });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptySummary(): UsageScanSummary {
  return {
    files: 0,
    filesRead: 0,
    bytesRead: 0,
    events: 0,
    durationMs: 0,
    roots: [],
    failedFiles: [],
    failedFilesDropped: 0,
    malformedLines: 0,
    oversizeLines: 0,
    forkCopiesSuppressed: 0,
  };
}
