import { access, chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
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
  // 2: generic record stores (automations, runs, triggers, drafts, heartbeats, attack runs and
  // findings) and append-only audit logs. Read by id, by parent, or as a list; a kind that needs a
  // real query gets its own table.
  `CREATE TABLE records (
     kind TEXT NOT NULL, id TEXT NOT NULL, parent_id TEXT, json TEXT NOT NULL,
     PRIMARY KEY (kind, id)) STRICT;
   CREATE INDEX records_parent ON records(kind, parent_id);
   CREATE TABLE audit (
     id INTEGER PRIMARY KEY, scope TEXT NOT NULL, ts TEXT NOT NULL, json TEXT NOT NULL) STRICT;
   CREATE INDEX audit_scope ON audit(scope, id);`,
  // 3: idempotency receipts (creation requests, their id claims, message sends), the metadata of
  // messages' attachment pills and the agent image index. Image and attachment bytes stay files.
  `CREATE TABLE receipts (
     kind TEXT NOT NULL, identity TEXT NOT NULL, updated_at INTEGER NOT NULL, json TEXT NOT NULL,
     PRIMARY KEY (kind, identity)) STRICT;
   CREATE INDEX receipts_updated ON receipts(kind, updated_at);
   CREATE TABLE sent_attachments (
     agent_id TEXT NOT NULL, message_id TEXT NOT NULL, json TEXT NOT NULL,
     PRIMARY KEY (agent_id, message_id)) STRICT;
   CREATE TABLE agent_image_index (
     agent_id TEXT NOT NULL, image_id TEXT NOT NULL, mime_type TEXT NOT NULL, origin TEXT NOT NULL,
     PRIMARY KEY (agent_id, image_id)) STRICT;`,
];

// pimi-timeline.db: chat timelines and their search index. Large and rebuildable from provider
// transcripts, so it is checked cheaply and never backed up (see openPimiTimelineDatabase).
const TIMELINE_SCHEMA_STEPS: readonly string[] = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
   CREATE TABLE timeline_agents (
     key INTEGER PRIMARY KEY,
     agent_id TEXT NOT NULL UNIQUE,
     epoch TEXT NOT NULL,
     row_format INTEGER NOT NULL,
     complete INTEGER NOT NULL DEFAULT 0,
     open_turn INTEGER NOT NULL DEFAULT 0,
     provider_subagents INTEGER NOT NULL DEFAULT 0,
     session_key TEXT,
     fingerprint TEXT,
     indexed_lo INTEGER NOT NULL DEFAULT 0,
     indexed_hi INTEGER NOT NULL DEFAULT 0,
     updated_at TEXT NOT NULL) STRICT;
   CREATE TABLE timeline_rows (
     agent_key INTEGER NOT NULL REFERENCES timeline_agents(key) ON DELETE CASCADE,
     seq INTEGER NOT NULL,
     ts TEXT NOT NULL,
     turn_id TEXT,
     provider_message_id TEXT,
     carried INTEGER NOT NULL DEFAULT 0,
     type TEXT NOT NULL,
     json TEXT NOT NULL,
     PRIMARY KEY (agent_key, seq)) STRICT;
   CREATE TABLE timeline_docs (
     id INTEGER PRIMARY KEY,
     agent_key INTEGER NOT NULL REFERENCES timeline_agents(key) ON DELETE CASCADE,
     seq_start INTEGER NOT NULL,
     seq_end INTEGER NOT NULL,
     kind TEXT NOT NULL,
     ts TEXT NOT NULL,
     text TEXT NOT NULL,
     UNIQUE (agent_key, seq_start)) STRICT;
   CREATE VIRTUAL TABLE timeline_fts USING fts5(
     text, content='timeline_docs', content_rowid='id',
     tokenize='unicode61 remove_diacritics 2');
   CREATE TRIGGER timeline_docs_ai AFTER INSERT ON timeline_docs BEGIN
     INSERT INTO timeline_fts(rowid, text) VALUES (new.id, new.text);
   END;
   CREATE TRIGGER timeline_docs_ad AFTER DELETE ON timeline_docs BEGIN
     INSERT INTO timeline_fts(timeline_fts, rowid, text) VALUES ('delete', old.id, old.text);
   END;
   CREATE TRIGGER timeline_docs_au AFTER UPDATE ON timeline_docs BEGIN
     INSERT INTO timeline_fts(timeline_fts, rowid, text) VALUES ('delete', old.id, old.text);
     INSERT INTO timeline_fts(rowid, text) VALUES (new.id, new.text);
   END;`,
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

export function pimiTimelineDatabasePath(pimiHome: string): string {
  return join(pimiHome, "pimi-timeline.db");
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

function openChecked(path: string, check: "integrity" | "quick"): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const pragma = check === "quick" ? "quick_check" : "integrity_check";
    const row = db.prepare(`PRAGMA ${pragma}`).get();
    if (row?.[pragma] !== "ok") {
      throw new Error(`${pragma}: ${String(row?.[pragma])}`);
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

async function moveAside(
  path: string,
  logger: Logger,
  reason: unknown,
  consequence: string,
): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const suffix of ["", "-wal", "-shm"]) {
    if (await exists(path + suffix)) {
      await rename(path + suffix, `${path}.corrupt-${stamp}${suffix}`);
    }
  }
  logger.error(
    { err: reason, path },
    `${basename(path)} failed its check; moved aside. ${consequence}`,
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

// chat text and agent records are private to the user: the files, and the WAL files SQLite creates
// beside them, are readable by the owner only. Best effort (a no-op on Windows).
async function restrictToOwner(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm", ".bak"]) {
    await chmod(path + suffix, 0o600).catch(() => undefined);
  }
}

interface OpenDatabaseOptions {
  pimiHome: string;
  logger: Logger;
  path: string;
  schemaSteps: readonly string[];
  check: "integrity" | "quick";
  backup: boolean;
  consequence: string;
}

async function openDatabase(options: OpenDatabaseOptions): Promise<PimiDatabase> {
  const logger = options.logger.child({ module: "db" });
  await mkdir(options.pimiHome, { recursive: true });
  const { path, schemaSteps } = options;
  // Create the file owner-only up front, so there is no window where it is world-readable.
  await (await open(path, "a", 0o600)).close();
  let db: DatabaseSync;
  try {
    db = openChecked(path, options.check);
  } catch (error) {
    if (!(await exists(path))) throw error;
    await moveAside(path, logger, error, options.consequence);
    db = openChecked(path, options.check);
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
  if (version > schemaSteps.length) {
    db.close();
    throw new Error(
      `${basename(path)} is schema v${version} but this daemon only knows v${
        schemaSteps.length
      }; refusing to open it`,
    );
  }
  for (let next = version; next < schemaSteps.length; next += 1) {
    transaction(() => {
      db.exec(schemaSteps[next]);
      db.exec(`PRAGMA user_version = ${next + 1}`);
    });
  }
  if (options.backup) await backupIfDue(db, path, logger);
  await restrictToOwner(path);

  return { db, path, transaction, close: () => db.close() };
}

// Opens $PIMI_HOME/pimi.db, applies pending schema steps, and backs it up at most once a day. A
// database that fails integrity_check is moved aside (never deleted) and replaced by an empty one.
export function openPimiDatabase(options: {
  pimiHome: string;
  logger: Logger;
}): Promise<PimiDatabase> {
  return openDatabase({
    ...options,
    path: pimiDatabasePath(options.pimiHome),
    schemaSteps: SCHEMA_STEPS,
    check: "integrity",
    backup: true,
    consequence: "Starting empty.",
  });
}

// Opens $PIMI_HOME/pimi-timeline.db (chat timelines and the search index). It is rebuildable from
// provider transcripts, so it gets the cheap quick_check and no daily backup; a corrupt file is
// moved aside and every chat rebuilds from its provider. Rows carried over a provider switch exist
// nowhere else and are re-imported from pimi.db only if that copy is still there.
export function openPimiTimelineDatabase(options: {
  pimiHome: string;
  logger: Logger;
}): Promise<PimiDatabase> {
  return openDatabase({
    ...options,
    path: pimiTimelineDatabasePath(options.pimiHome),
    schemaSteps: TIMELINE_SCHEMA_STEPS,
    check: "quick",
    backup: false,
    consequence:
      "Chats rebuild from their providers; rows carried over a provider switch are re-imported from pimi.db when present.",
  });
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
