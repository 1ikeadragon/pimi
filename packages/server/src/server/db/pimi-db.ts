import { access, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Logger } from "pino";

export type { DatabaseSync } from "node:sqlite";

// One step per schema version, applied in order inside a transaction each. Append only: a step that
// has shipped is never edited. PRAGMA user_version holds the number of applied steps.
const SCHEMA_STEPS: readonly string[] = [
  // 1: meta and agents. `json` is a StoredAgentRecord without `persistence`, which lives in its own
  // table because it is ~80% of the bytes and only provider resume needs it.
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
   CREATE TABLE agents (
     id TEXT PRIMARY KEY, workspace_id TEXT, provider TEXT NOT NULL, cwd TEXT NOT NULL,
     archived_at TEXT, internal INTEGER NOT NULL DEFAULT 0, background INTEGER NOT NULL DEFAULT 0,
     updated_at TEXT NOT NULL, last_user_message_at TEXT,
     persistence_provider TEXT, provider_session_id TEXT, provider_native_handle TEXT,
     json TEXT NOT NULL) STRICT;
   CREATE INDEX agents_workspace ON agents(workspace_id, archived_at);
   CREATE INDEX agents_session ON agents(persistence_provider, provider_session_id);
   CREATE INDEX agents_native ON agents(persistence_provider, provider_native_handle);
   CREATE TABLE agent_persistence (
     agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE, json TEXT NOT NULL) STRICT;`,
];

const BACKUP_INTERVAL_MS = 24 * 60 * 60_000;

export interface PimiDatabase {
  readonly db: DatabaseSync;
  readonly path: string;
  // Runs fn in BEGIN IMMEDIATE .. COMMIT; rolls back and rethrows on error. fn must be synchronous.
  transaction<T>(fn: () => T): T;
  close(): void;
}

export function pimiDatabasePath(pimiHome: string): string {
  return join(pimiHome, "pimi.db");
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

function openChecked(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const row = db.prepare("PRAGMA integrity_check").get();
    if (row?.integrity_check !== "ok") {
      throw new Error(`integrity_check: ${String(row?.integrity_check)}`);
    }
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {
      // already unusable
    }
    throw error;
  }
}

async function moveAside(path: string, logger: Logger, reason: unknown): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const suffix of ["", "-wal", "-shm"]) {
    if (await exists(path + suffix)) {
      await rename(path + suffix, `${path}.corrupt-${stamp}${suffix}`);
    }
  }
  logger.error(
    { err: reason, path },
    "pimi.db failed its integrity check; moved aside, starting empty",
  );
}

async function backupIfDue(db: DatabaseSync, path: string, logger: Logger): Promise<void> {
  const backupPath = `${path}.bak`;
  try {
    const previous = await stat(backupPath).catch(() => null);
    if (previous && Date.now() - previous.mtimeMs < BACKUP_INTERVAL_MS) return;
    const tmp = `${backupPath}.tmp`;
    await rm(tmp, { force: true });
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    await rename(tmp, backupPath);
  } catch (error) {
    logger.warn({ err: error }, "Failed to back up pimi.db");
  }
}

// Opens $PIMI_HOME/pimi.db, applies pending schema steps, and backs it up at most once a day. A
// database that fails integrity_check is moved aside (never deleted) and replaced by an empty one.
export async function openPimiDatabase(options: {
  pimiHome: string;
  logger: Logger;
}): Promise<PimiDatabase> {
  const logger = options.logger.child({ module: "db" });
  await mkdir(options.pimiHome, { recursive: true });
  const path = pimiDatabasePath(options.pimiHome);
  let db: DatabaseSync;
  try {
    db = openChecked(path);
  } catch (error) {
    if (!(await exists(path))) throw error;
    await moveAside(path, logger, error);
    db = openChecked(path);
  }
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = ON");

  const transaction = <T>(fn: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (version > SCHEMA_STEPS.length) {
    db.close();
    throw new Error(
      `pimi.db is schema v${version} but this daemon only knows v${SCHEMA_STEPS.length}; refusing to open it`,
    );
  }
  for (let next = version; next < SCHEMA_STEPS.length; next += 1) {
    transaction(() => {
      db.exec(SCHEMA_STEPS[next]);
      db.exec(`PRAGMA user_version = ${next + 1}`);
    });
  }
  await backupIfDue(db, path, logger);

  return { db, path, transaction, close: () => db.close() };
}

// Runs a one-time import of legacy JSON files. `name` gates it through a meta row, so a second
// start never re-imports. fn imports inside the transaction it is given; afterwards each directory
// in `legacyPaths` is renamed to `<path>.migrated` (never deleted). Invalid files are fn's to log
// and skip. Returns whether the import ran.
export async function runJsonImportOnce(
  database: PimiDatabase,
  options: { name: string; legacyPaths: string[]; logger: Logger },
  fn: () => void,
): Promise<boolean> {
  const key = `imported_${options.name}`;
  if (database.db.prepare("SELECT 1 AS present FROM meta WHERE key = ?").get(key)) return false;
  database.transaction(() => {
    fn();
    database.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?)")
      .run(key, new Date().toISOString());
  });
  for (const legacyPath of options.legacyPaths) {
    if (!(await exists(legacyPath))) continue;
    const target = `${legacyPath}.migrated`;
    try {
      await rename(legacyPath, (await exists(target)) ? `${target}-${Date.now()}` : target);
    } catch (error) {
      options.logger.warn({ err: error, legacyPath }, "Failed to rename imported legacy path");
    }
  }
  options.logger.info({ name: options.name }, "Imported legacy JSON into pimi.db");
  return true;
}

// Rows of one table as parsed objects (JSON columns are expanded), for `pimi daemon db dump`.
// Opens the file read-only, so it is safe beside a running daemon (WAL).
export async function dumpPimiDatabaseTable(
  pimiHome: string,
  table: string,
): Promise<Record<string, unknown>[]> {
  const path = pimiDatabasePath(pimiHome);
  if (!(await exists(path))) throw new Error(`No database at ${path}`);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => String(row.name));
    if (!names.includes(table)) {
      throw new Error(`Unknown table "${table}". Tables: ${names.join(", ")}`);
    }
    return db
      .prepare(`SELECT * FROM "${table}"`)
      .all()
      .map((row) => {
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) {
          if (key === "json" && typeof value === "string") {
            try {
              out[key] = JSON.parse(value);
              continue;
            } catch {
              // keep the raw text
            }
          }
          out[key] = value instanceof Uint8Array ? `<${value.byteLength} bytes>` : value;
        }
        return out;
      });
  } finally {
    db.close();
  }
}
