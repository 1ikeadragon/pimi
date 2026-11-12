import { chmod, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { z } from "zod";
import { writeJsonFileAtomic } from "./atomic-file.js";

interface JsonRecordStoreOptions<T extends { id: string }> {
  dir: string;
  schema: z.ZodType<T>;
  logger: Logger;
  label: string;
}

// A cached listing is re-read from disk at most this often, so a hand edit or a copy made outside
// this process shows up within a minute. Writes from this process update the cache immediately.
const LIST_REVALIDATE_MS = 60_000;

// One JSON file per record in a private (0700) directory. Updates to one record are
// serialized; a file that does not parse is reported once and skipped. list() serves a cache
// filled by one directory scan and kept current by this store's own writes; callers that change
// files behind the store's back call invalidate().
export class JsonRecordStore<T extends { id: string }> {
  private readonly dir: string;
  private readonly schema: z.ZodType<T>;
  private readonly logger: Logger;
  private readonly label: string;
  private readonly mutations = new Map<string, Promise<unknown>>();
  private reportedInvalidFiles = new Set<string>();
  private dirReady: Promise<void> | null = null;
  private cache: Map<string, T> | null = null;
  private cachedAt = 0;
  private loading: Promise<Map<string, T>> | null = null;
  // Bumped by every write; a scan that overlapped a write is not installed as the cache.
  private writeVersion = 0;

  constructor(options: JsonRecordStoreOptions<T>) {
    this.dir = options.dir;
    this.schema = options.schema;
    this.logger = options.logger;
    this.label = options.label;
  }

  private filePath(id: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new Error(`Invalid ${this.label} id: ${id}`);
    }
    return join(this.dir, `${id}.json`);
  }

  private ensureDir(): Promise<void> {
    this.dirReady ??= (async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await chmod(this.dir, 0o700);
    })();
    return this.dirReady;
  }

  // Drops the cached listing; the next list() scans the directory again.
  invalidate(): void {
    this.cache = null;
    this.writeVersion += 1;
  }

  async list(): Promise<T[]> {
    if (!this.cache || Date.now() - this.cachedAt > LIST_REVALIDATE_MS) {
      this.loading ??= this.scan().finally(() => {
        this.loading = null;
      });
      const scanned = await this.loading;
      return [...scanned.values()].map((record) => structuredClone(record));
    }
    // Callers own what they get back; a clone keeps them from editing the cache.
    return [...this.cache.values()].map((record) => structuredClone(record));
  }

  private async scan(): Promise<Map<string, T>> {
    const version = this.writeVersion;
    await this.ensureDir();
    const entries = await readdir(this.dir, { withFileTypes: true });
    const records = new Map<string, T>();
    const invalidFiles = new Set<string>();
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const filePath = join(this.dir, entry.name);
      let content: string;
      try {
        content = await readFile(filePath, "utf-8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw error;
      }
      const parsed = this.parse(content);
      if (parsed.success) {
        records.set(entry.name.slice(0, -".json".length), parsed.data);
        continue;
      }
      invalidFiles.add(filePath);
      if (!this.reportedInvalidFiles.has(filePath)) {
        this.logger.error({ err: parsed.error, filePath }, `Skipping invalid ${this.label} file`);
      }
    }
    this.reportedInvalidFiles = invalidFiles;
    if (version === this.writeVersion) {
      this.cache = records;
      this.cachedAt = Date.now();
    }
    return records;
  }

  async get(id: string): Promise<T | null> {
    await this.ensureDir();
    try {
      const content = await readFile(this.filePath(id), "utf-8");
      return this.schema.parse(JSON.parse(content));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async put(record: T): Promise<T> {
    return this.serialize(record.id, () => this.write(record));
  }

  // Returns null when the record does not exist. Returning the same object skips the write.
  async update(id: string, updater: (current: T) => T | Promise<T>): Promise<T | null> {
    return this.serialize(id, async () => {
      const current = await this.get(id);
      if (!current) {
        return null;
      }
      const next = await updater(current);
      if (next === current) {
        return current;
      }
      if (next.id !== id) {
        throw new Error(`${this.label} update cannot change id: ${id}`);
      }
      return this.write(next);
    });
  }

  async delete(id: string): Promise<void> {
    await this.serialize(id, async () => {
      await this.ensureDir();
      await rm(this.filePath(id), { force: true });
      this.writeVersion += 1;
      this.cache?.delete(id);
    });
  }

  private async write(record: T): Promise<T> {
    const parsed = this.schema.parse(record);
    await this.ensureDir();
    await writeJsonFileAtomic(this.filePath(parsed.id), parsed);
    this.writeVersion += 1;
    this.cache?.set(parsed.id, structuredClone(parsed));
    return parsed;
  }

  private parse(content: string): { success: true; data: T } | { success: false; error: unknown } {
    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch (error) {
      return { success: false, error };
    }
    const result = this.schema.safeParse(json);
    return result.success ? { success: true, data: result.data } : result;
  }

  private async serialize<R>(key: string, mutation: () => Promise<R>): Promise<R> {
    const previous = this.mutations.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(mutation);
    this.mutations.set(key, next);
    try {
      return await next;
    } finally {
      if (this.mutations.get(key) === next) {
        this.mutations.delete(key);
      }
    }
  }
}
