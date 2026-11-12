import { appendFile, chmod, mkdir, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { NetworkActivityRequest } from "@pimi/protocol/messages";
import { ensurePrivateDirectory } from "../private-files.js";

// Persists finished network records as JSONL under <home>/logs/network. Each process writes
// its own files (daemon-YYYY-MM-DD.jsonl, app-YYYY-MM-DD.jsonl). Appends are buffered and
// asynchronous, files roll over at a size limit, and a sweep removes files past the retention
// window and then the oldest files while the folder exceeds its cap; a write that would cross
// the cap sweeps first, so the cap holds between sweeps too. Files are mode 0600. Process
// launches that repeat identically within COALESCE_WINDOW_MS become one line with a count.

export const NETWORK_LOG_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const NETWORK_LOG_MAX_DIRECTORY_BYTES = 200 * 1024 * 1024;
const FLUSH_DELAY_MS = 1_000;
const FLUSH_THRESHOLD_BYTES = 256 * 1024;
// Lines waiting for the disk. Past this, the oldest are dropped and counted.
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
// Identical launches (same program, arguments, purpose and outcome) inside this window from the
// first one are written once, with a count. Nothing is dropped; a burst keeps its size and span.
const COALESCE_WINDOW_MS = 5_000;
const MAX_COALESCING_KEYS = 512;
// A write over the cap sweeps first; a sweep that removes nothing is not repeated sooner.
const CAP_SWEEP_MIN_GAP_MS = 10_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const FILE_NAME = /^(daemon|app)-(\d{4})-(\d{2})-(\d{2})(?:\.(\d+))?\.jsonl$/;

export interface NetworkLogSettings {
  enabled: boolean;
  retentionDays: number;
}

export interface NetworkLogStoreOptions {
  /** The pimi home; files go to <home>/logs/network. */
  home: string;
  /** Which process writes: "daemon" or "app". */
  source: "daemon" | "app";
  getSettings: () => NetworkLogSettings;
  maxFileBytes?: number;
  maxDirectoryBytes?: number;
  now?: () => number;
  onError?: (error: unknown, message: string) => void;
}

export interface NetworkLogStats {
  directory: string;
  bytes: number;
  files: number;
}

interface LogFileEntry {
  name: string;
  dayStartMs: number;
  index: number;
  size: number;
}

export function networkLogDirectory(home: string): string {
  return path.join(home, "logs", "network");
}

function dayStamp(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function parseFileName(name: string): { dayStartMs: number; index: number } | null {
  const match = FILE_NAME.exec(name);
  if (!match) return null;
  const dayStartMs = new Date(Number(match[2]), Number(match[3]) - 1, Number(match[4])).getTime();
  if (Number.isNaN(dayStartMs)) return null;
  return { dayStartMs, index: match[5] ? Number(match[5]) : 0 };
}

interface CoalescedLaunch {
  record: NetworkActivityRequest;
  ts: number;
  count: number;
  totalDurationMs: number;
  lastStartedAtMs: number;
  timer: NodeJS.Timeout;
}

function coalesceKey(record: NetworkActivityRequest): string | null {
  if (record.protocol !== "process" || record.counters) return null;
  return JSON.stringify([
    record.source,
    record.method,
    record.host,
    record.port,
    record.path,
    record.status,
    record.errorCode,
    record.purpose,
  ]);
}

function recordLine(
  record: NetworkActivityRequest,
  source: string,
  ts: number,
  repeat?: { count: number; totalDurationMs: number; lastStartedAtMs: number },
): string {
  // Explicit fields, so a field added to a record later is never logged by accident.
  return `${JSON.stringify({
    ts: new Date(ts).toISOString(),
    source: record.source || source,
    id: record.id,
    method: record.method,
    protocol: record.protocol,
    host: record.host,
    port: record.port,
    path: record.path,
    status: record.status,
    errorCode: record.errorCode,
    startedAtMs: record.startedAtMs,
    durationMs: record.durationMs,
    responseBytes: record.responseBytes,
    purpose: record.purpose,
    known: record.known,
    local: record.local,
    ...(record.counters ? { counters: record.counters } : {}),
    ...(repeat && repeat.count > 1
      ? {
          count: repeat.count,
          totalDurationMs: repeat.totalDurationMs,
          lastStartedAtMs: repeat.lastStartedAtMs,
        }
      : {}),
  })}\n`;
}

export class NetworkLogStore {
  private readonly directory: string;
  private readonly source: "daemon" | "app";
  private readonly getSettings: () => NetworkLogSettings;
  private readonly maxFileBytes: number;
  private readonly maxDirectoryBytes: number;
  private readonly now: () => number;
  private readonly onError: (error: unknown, message: string) => void;
  private buffer: string[] = [];
  private bufferedBytes = 0;
  private dropped = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private pending: Promise<void> = Promise.resolve();
  private current: { name: string; size: number } | null = null;
  private closed = false;
  private readonly coalescing = new Map<string, CoalescedLaunch>();
  private lastFutileCapSweepAtMs = 0;
  private knownBytes = 0;
  private knownFiles = 0;

  constructor(options: NetworkLogStoreOptions) {
    this.directory = networkLogDirectory(options.home);
    this.source = options.source;
    this.getSettings = options.getSettings;
    this.maxFileBytes = options.maxFileBytes ?? NETWORK_LOG_MAX_FILE_BYTES;
    this.maxDirectoryBytes = options.maxDirectoryBytes ?? NETWORK_LOG_MAX_DIRECTORY_BYTES;
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? (() => undefined);
  }

  get logDirectory(): string {
    return this.directory;
  }

  /** Creates the folder, sweeps once, and sweeps hourly from then on. */
  start(): void {
    try {
      ensurePrivateDirectory(path.join(this.directory, ".."));
      ensurePrivateDirectory(this.directory);
    } catch (error) {
      this.onError(error, "Could not create the network log folder");
    }
    void this.sweep();
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  append(record: NetworkActivityRequest): void {
    if (this.closed || !this.getSettings().enabled) return;
    const key = coalesceKey(record);
    if (key !== null && this.coalesce(key, record)) return;
    this.enqueue(recordLine(record, this.source, this.now()));
  }

  /** Folds a repeat into its open entry, or opens one. False when the table is full. */
  private coalesce(key: string, record: NetworkActivityRequest): boolean {
    const open = this.coalescing.get(key);
    if (open) {
      open.count += 1;
      open.totalDurationMs += record.durationMs ?? 0;
      open.lastStartedAtMs = record.startedAtMs;
      return true;
    }
    if (this.coalescing.size >= MAX_COALESCING_KEYS) return false;
    const timer = setTimeout(() => this.closeCoalesced(key), COALESCE_WINDOW_MS);
    timer.unref();
    this.coalescing.set(key, {
      record,
      ts: this.now(),
      count: 1,
      totalDurationMs: record.durationMs ?? 0,
      lastStartedAtMs: record.startedAtMs,
      timer,
    });
    return true;
  }

  private closeCoalesced(key: string): void {
    const entry = this.coalescing.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.coalescing.delete(key);
    this.enqueue(recordLine(entry.record, this.source, entry.ts, entry));
  }

  private closeAllCoalesced(): void {
    for (const key of this.coalescing.keys()) this.closeCoalesced(key);
  }

  private enqueue(line: string): void {
    const bytes = Buffer.byteLength(line);
    this.buffer.push(line);
    this.bufferedBytes += bytes;
    while (this.bufferedBytes > MAX_BUFFERED_BYTES && this.buffer.length > 1) {
      const removed = this.buffer.shift()!;
      this.bufferedBytes -= Buffer.byteLength(removed);
      this.dropped += 1;
    }
    if (this.bufferedBytes >= FLUSH_THRESHOLD_BYTES) {
      void this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => void this.flush(), FLUSH_DELAY_MS);
      this.flushTimer.unref();
    }
  }

  /** Writes everything buffered so far. Writes are serialized, so order is preserved. */
  flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const lines = this.buffer;
    if (lines.length === 0) return this.pending;
    this.buffer = [];
    this.bufferedBytes = 0;
    this.pending = this.pending.then(() => this.write(lines));
    return this.pending;
  }

  async close(): Promise<void> {
    this.closeAllCoalesced();
    await this.flush();
    this.closed = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /** The size last measured by a sweep, plus what has been written since. Cheap and synchronous. */
  stats(): NetworkLogStats {
    return { directory: this.directory, bytes: this.knownBytes, files: this.knownFiles };
  }

  /**
   * Removes files older than the retention window, then the oldest while over the cap.
   * `reserveBytes` leaves room under the cap for a write that is about to land.
   */
  async sweep(reserveBytes = 0): Promise<void> {
    try {
      const { retentionDays } = this.getSettings();
      const now = this.now();
      let files = await this.listFiles();
      const expired = files.filter(
        (file) => file.dayStartMs + DAY_MS <= now - retentionDays * DAY_MS,
      );
      await Promise.all(expired.map((file) => this.remove(file)));
      files = files.filter((file) => !expired.includes(file));
      let total = files.reduce((sum, file) => sum + file.size, 0);
      this.knownBytes = total;
      this.knownFiles = files.length;
      const oldestFirst = [...files].sort(
        (a, b) => a.dayStartMs - b.dayStartMs || a.index - b.index || a.name.localeCompare(b.name),
      );
      for (const file of oldestFirst) {
        if (total + reserveBytes <= this.maxDirectoryBytes) break;
        if (file.name === this.current?.name) continue;
        await this.remove(file);
        total -= file.size;
        this.knownBytes = total;
        this.knownFiles -= 1;
      }
    } catch (error) {
      this.onError(error, "Network log sweep failed");
    }
  }

  private async remove(file: LogFileEntry): Promise<void> {
    try {
      await unlink(path.join(this.directory, file.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.onError(error, "Could not remove an old network log file");
      }
    }
  }

  private async listFiles(): Promise<LogFileEntry[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const files: LogFileEntry[] = [];
    for (const name of names) {
      const parsed = parseFileName(name);
      if (!parsed) continue;
      try {
        const info = await stat(path.join(this.directory, name));
        if (info.isFile()) files.push({ name, ...parsed, size: info.size });
      } catch {
        // Removed by the other process between readdir and stat.
      }
    }
    return files;
  }

  /** The file for today: the newest roll of this process's day file with room left. */
  private async resolveFile(day: string, incoming: number): Promise<string> {
    const prefix = `${this.source}-${day}`;
    const currentRoll =
      this.current && this.current.name.startsWith(`${prefix}`) ? this.current : null;
    if (
      currentRoll &&
      (currentRoll.size === 0 || currentRoll.size + incoming <= this.maxFileBytes)
    ) {
      return currentRoll.name;
    }
    let index = 0;
    let size = 0;
    if (currentRoll) {
      index = (parseFileName(currentRoll.name)?.index ?? 0) + 1;
    } else {
      const existing = (await this.listFiles())
        .filter((file) => file.name.startsWith(`${prefix}.`) || file.name === `${prefix}.jsonl`)
        .sort((a, b) => b.index - a.index)[0];
      if (existing) {
        index = existing.index;
        size = existing.size;
        if (size > 0 && size + incoming > this.maxFileBytes) {
          index += 1;
          size = 0;
        }
      }
    }
    const name = index === 0 ? `${prefix}.jsonl` : `${prefix}.${index}.jsonl`;
    this.current = { name, size };
    return name;
  }

  private async write(lines: string[]): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const day = dayStamp(this.now());
      let batch = "";
      let batchBytes = 0;
      const emit = async () => {
        if (batch === "") return;
        if (
          this.knownBytes + batchBytes > this.maxDirectoryBytes &&
          this.now() - this.lastFutileCapSweepAtMs >= CAP_SWEEP_MIN_GAP_MS
        ) {
          const before = this.knownFiles;
          await this.sweep(batchBytes);
          // Nothing but the live file was left to remove: do not re-scan the folder on every write.
          this.lastFutileCapSweepAtMs = this.knownFiles >= before ? this.now() : 0;
        }
        const name = await this.resolveFile(day, batchBytes);
        const target = path.join(this.directory, name);
        const created = this.current!.size === 0;
        await appendFile(target, batch, { mode: 0o600 });
        // appendFile applies the mode only on creation, and the umask can narrow it further.
        if (created && process.platform !== "win32")
          await chmod(target, 0o600).catch(() => undefined);
        this.current!.size += batchBytes;
        this.knownBytes += batchBytes;
        if (created) this.knownFiles += 1;
        batch = "";
        batchBytes = 0;
      };
      for (const line of lines) {
        const bytes = Buffer.byteLength(line);
        if (batchBytes + bytes > this.maxFileBytes / 4) await emit();
        batch += line;
        batchBytes += bytes;
      }
      await emit();
      if (this.dropped > 0) {
        this.onError(new Error(`${this.dropped} records dropped`), "Network log buffer overflowed");
        this.dropped = 0;
      }
    } catch (error) {
      this.onError(error, "Could not write the network log");
    }
  }
}
