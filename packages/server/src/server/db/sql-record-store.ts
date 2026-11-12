import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { z } from "zod";
import type { PimiDatabase } from "./pimi-db.js";

interface SqlRecordStoreOptions<T extends { id: string }> {
  database: PimiDatabase;
  // Namespace in the `records` table, e.g. "automation_run".
  kind: string;
  // Groups records of one kind under an owner, e.g. the automation a run belongs to.
  parentId?: string;
  schema: z.ZodType<T>;
  logger: Logger;
  label: string;
}

type Row = Record<string, string | number | bigint | null | Uint8Array>;

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const AUDIT_ENTRIES_KEPT = 2000;

// Records of one kind (and parent) in the `records` table, one JSON document per row. The Zod schema
// stays the authority: it runs before every write and on every read; a row that no longer parses is
// reported once and skipped. Reads and writes are synchronous statements; update() keeps a per-id
// queue only because its updater may be async.
export class SqlRecordStore<T extends { id: string }> {
  private readonly database: PimiDatabase;
  private readonly kind: string;
  private readonly parentId: string | null;
  private readonly schema: z.ZodType<T>;
  private readonly logger: Logger;
  private readonly label: string;
  private readonly mutations = new Map<string, Promise<unknown>>();
  private readonly reportedInvalid = new Set<string>();

  constructor(options: SqlRecordStoreOptions<T>) {
    this.database = options.database;
    this.kind = options.kind;
    this.parentId = options.parentId ?? null;
    this.schema = options.schema;
    this.logger = options.logger;
    this.label = options.label;
  }

  private assertId(id: string): void {
    if (!ID_PATTERN.test(id)) throw new Error(`Invalid ${this.label} id: ${id}`);
  }

  private parse(row: Row): T | null {
    const result = this.schema.safeParse(JSON.parse(String(row.json)));
    if (result.success) return result.data;
    const key = String(row.id);
    if (!this.reportedInvalid.has(key)) {
      this.reportedInvalid.add(key);
      this.logger.error({ err: result.error, id: key }, `Skipping invalid ${this.label} record`);
    }
    return null;
  }

  async list(): Promise<T[]> {
    const rows = this.database.db
      .prepare("SELECT id, json FROM records WHERE kind = ? AND parent_id IS ? ORDER BY rowid")
      .all(this.kind, this.parentId) as Row[];
    return rows.flatMap((row) => this.parse(row) ?? []);
  }

  async get(id: string): Promise<T | null> {
    this.assertId(id);
    const row = this.database.db
      .prepare("SELECT id, json FROM records WHERE kind = ? AND id = ?")
      .get(this.kind, id) as Row | undefined;
    return row ? this.parse(row) : null;
  }

  async put(record: T): Promise<T> {
    return this.serialize(record.id, async () => this.write(record));
  }

  // Returns null when the record does not exist. Returning the same object skips the write.
  async update(id: string, updater: (current: T) => T | Promise<T>): Promise<T | null> {
    return this.serialize(id, async () => {
      const current = await this.get(id);
      if (!current) return null;
      const next = await updater(current);
      if (next === current) return current;
      if (next.id !== id) throw new Error(`${this.label} update cannot change id: ${id}`);
      return this.write(next);
    });
  }

  async delete(id: string): Promise<void> {
    this.assertId(id);
    await this.serialize(id, async () => {
      this.database.db.prepare("DELETE FROM records WHERE kind = ? AND id = ?").run(this.kind, id);
    });
  }

  // Removes every record of this store's kind and parent.
  deleteAll(): void {
    this.database.db
      .prepare("DELETE FROM records WHERE kind = ? AND parent_id IS ?")
      .run(this.kind, this.parentId);
  }

  private write(record: T): T {
    const parsed = this.schema.parse(record);
    this.assertId(parsed.id);
    insertRecord(this.database, this.kind, this.parentId, parsed.id, parsed);
    return parsed;
  }

  private async serialize<R>(key: string, mutation: () => Promise<R>): Promise<R> {
    const previous = this.mutations.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(mutation);
    this.mutations.set(key, next);
    try {
      return await next;
    } finally {
      if (this.mutations.get(key) === next) this.mutations.delete(key);
    }
  }
}

export function insertRecord(
  database: PimiDatabase,
  kind: string,
  parentId: string | null,
  id: string,
  value: unknown,
): void {
  database.db
    .prepare(
      `INSERT INTO records (kind, id, parent_id, json) VALUES (?, ?, ?, ?)
       ON CONFLICT(kind, id) DO UPDATE SET parent_id = excluded.parent_id, json = excluded.json`,
    )
    .run(kind, id, parentId, JSON.stringify(value));
}

// Append-only log kept per scope (an automation id, an attack run id); the newest entries stay.
export class SqlAuditLog<T> {
  constructor(
    private readonly database: PimiDatabase,
    private readonly scope: string,
    private readonly schema: z.ZodType<T>,
  ) {}

  append(entry: unknown): void {
    const at = new Date().toISOString();
    insertAudit(this.database, this.scope, at, { at, ...(entry as object) });
    this.database.db
      .prepare(
        `DELETE FROM audit WHERE scope = ? AND id <= COALESCE(
           (SELECT id FROM audit WHERE scope = ? ORDER BY id DESC LIMIT 1 OFFSET ?), 0)`,
      )
      .run(this.scope, this.scope, AUDIT_ENTRIES_KEPT);
  }

  // The newest `limit` entries, oldest first.
  read(limit: number): T[] {
    const rows = this.database.db
      .prepare("SELECT json FROM audit WHERE scope = ? ORDER BY id DESC LIMIT ?")
      .all(this.scope, limit) as Row[];
    return rows
      .map((row) => this.schema.safeParse(JSON.parse(String(row.json))))
      .flatMap((result) => (result.success ? [result.data] : []))
      .toReversed();
  }
}

export function insertAudit(
  database: PimiDatabase,
  scope: string,
  ts: string,
  entry: unknown,
): void {
  database.db
    .prepare("INSERT INTO audit (scope, ts, json) VALUES (?, ?, ?)")
    .run(scope, ts, JSON.stringify(entry));
}

// ---- legacy import helpers: read old JSON files, skipping (and logging) the ones that do not parse

export async function readLegacyJsonDir<T>(
  dir: string,
  schema: z.ZodType<T>,
  logger: Logger,
  prepare: (json: unknown) => unknown = (json) => json,
): Promise<T[]> {
  const out: T[] = [];
  for (const name of await listFiles(dir, ".json")) {
    const filePath = join(dir, name);
    try {
      out.push(schema.parse(prepare(JSON.parse(await readFile(filePath, "utf-8")))));
    } catch (error) {
      logger.error({ err: error, filePath }, "Skipping invalid legacy record file");
    }
  }
  return out;
}

export async function readLegacyJsonFile<T>(
  filePath: string,
  schema: z.ZodType<T>,
  logger: Logger,
): Promise<T | null> {
  try {
    return schema.parse(JSON.parse(await readFile(filePath, "utf-8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.error({ err: error, filePath }, "Skipping invalid legacy record file");
    }
    return null;
  }
}

export async function readLegacyJsonLines<T>(filePath: string, schema: z.ZodType<T>): Promise<T[]> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const out: T[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = schema.safeParse(JSON.parse(line));
      if (parsed.success) out.push(parsed.data);
    } catch {
      // a torn last line from a crash
    }
  }
  return out;
}

export async function listFiles(dir: string, suffix: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function listDirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
