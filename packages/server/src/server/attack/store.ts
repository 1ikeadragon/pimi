import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import {
  AttackAuditEntrySchema,
  AttackRunSchema,
  FindingSchema,
  type AttackRun,
  type Finding,
} from "@pimi/protocol/attack/types";
import { runJsonImportOnce, type PimiDatabase } from "../db/pimi-db.js";
import {
  SqlRecordStore,
  insertAudit,
  insertRecord,
  listDirs,
  readLegacyJsonDir,
  readLegacyJsonFile,
  readLegacyJsonLines,
} from "../db/sql-record-store.js";
import { AttackAuditLog } from "./audit.js";

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

// A finished run (stopped or completed) is dropped only once it is both older than this and
// outside the newest FINISHED_RUNS_KEPT finished runs. 90 days is a quarter: long enough to
// re-open a past report or fix its findings; the count keeps a quiet user's last reports even
// after months away.
const FINISHED_RUN_RETENTION_MS = 90 * 24 * 60 * 60_000;
const FINISHED_RUNS_KEPT = 25;

function assertId(id: string): void {
  if (!ID_PATTERN.test(id)) throw new Error(`Invalid attack run id: ${id}`);
}

// Runs and findings are rows in pimi.db (kinds attack_run, and attack_finding with the run as
// parent); the audit log is `attack:<runId>` in the audit table. `dir` ($PIMI_HOME/attack-runs/
// <runId>/) still holds each run's annotation images, which stay files. Legacy run.json,
// findings/ and audit.jsonl are imported once and renamed with a .migrated suffix.
export class AttackStore {
  readonly dir: string;
  private readonly logger: Logger;
  private readonly database: PimiDatabase;
  private readonly runs: SqlRecordStore<AttackRun>;
  private readonly findingStores = new Map<string, SqlRecordStore<Finding>>();

  constructor(options: { database: PimiDatabase; dir: string; logger: Logger }) {
    this.database = options.database;
    this.dir = options.dir;
    this.logger = options.logger;
    this.runs = new SqlRecordStore({
      database: this.database,
      kind: "attack_run",
      schema: AttackRunSchema,
      logger: this.logger,
      label: "attack run",
    });
  }

  async importLegacy(): Promise<void> {
    const runs: AttackRun[] = [];
    const findings: Finding[][] = [];
    const audits: Array<{
      runId: string;
      entries: Awaited<ReturnType<typeof readLegacyJsonLines>>;
    }> = [];
    const legacyPaths: string[] = [];
    for (const runId of await listDirs(this.dir)) {
      if (!ID_PATTERN.test(runId)) continue;
      const runDir = join(this.dir, runId);
      const run = await readLegacyJsonFile(join(runDir, "run.json"), AttackRunSchema, this.logger);
      if (!run) continue;
      runs.push(run);
      findings.push(await readLegacyJsonDir(join(runDir, "findings"), FindingSchema, this.logger));
      audits.push({
        runId,
        entries: await readLegacyJsonLines(join(runDir, "audit.jsonl"), AttackAuditEntrySchema),
      });
      legacyPaths.push(
        join(runDir, "run.json"),
        join(runDir, "findings"),
        join(runDir, "audit.jsonl"),
      );
    }
    await runJsonImportOnce(
      this.database,
      { name: "attack", legacyPaths, logger: this.logger },
      () => {
        runs.forEach((run, index) => {
          insertRecord(this.database, "attack_run", null, run.id, run);
          for (const finding of findings[index]) {
            insertRecord(this.database, "attack_finding", run.id, finding.id, finding);
          }
          for (const entry of audits[index].entries as Array<{ at: string }>) {
            insertAudit(this.database, `attack:${run.id}`, entry.at, entry);
          }
        });
      },
    );
  }

  private runDir(runId: string): string {
    assertId(runId);
    return join(this.dir, runId);
  }

  findings(runId: string): SqlRecordStore<Finding> {
    assertId(runId);
    let store = this.findingStores.get(runId);
    if (!store) {
      store = new SqlRecordStore({
        database: this.database,
        kind: "attack_finding",
        parentId: runId,
        schema: FindingSchema,
        logger: this.logger,
        label: "attack finding",
      });
      this.findingStores.set(runId, store);
    }
    return store;
  }

  audit(runId: string): AttackAuditLog {
    assertId(runId);
    return new AttackAuditLog({ database: this.database, runId, logger: this.logger });
  }

  async getRun(runId: string): Promise<AttackRun | null> {
    return this.runs.get(runId);
  }

  async listRuns(): Promise<AttackRun[]> {
    return (await this.runs.list()).sort((left, right) =>
      right.startedAt.localeCompare(left.startedAt),
    );
  }

  // Removes finished runs that are past retention (see FINISHED_RUN_RETENTION_MS). A running or
  // paused run is never removed. Returns the ids removed.
  async pruneFinishedRuns(now: Date): Promise<string[]> {
    const finished = (await this.listRuns()).filter(
      (run) => run.status === "stopped" || run.status === "completed",
    );
    const cutoff = now.getTime() - FINISHED_RUN_RETENTION_MS;
    // listRuns is newest-started first, so the first FINISHED_RUNS_KEPT are protected.
    const doomed = finished.slice(FINISHED_RUNS_KEPT).filter((run) => {
      const finishedAt = Date.parse(run.endedAt ?? run.updatedAt);
      return Number.isFinite(finishedAt) && finishedAt < cutoff;
    });
    const removed: string[] = [];
    for (const run of doomed) {
      // Re-read: a run resumed since the listing must survive.
      const current = await this.getRun(run.id);
      if (!current || (current.status !== "stopped" && current.status !== "completed")) continue;
      this.database.transaction(() => {
        this.findings(run.id).deleteAll();
        this.database.db.prepare("DELETE FROM audit WHERE scope = ?").run(`attack:${run.id}`);
        this.database.db
          .prepare("DELETE FROM records WHERE kind = 'attack_run' AND id = ?")
          .run(run.id);
      });
      await rm(this.runDir(run.id), { recursive: true, force: true });
      this.findingStores.delete(run.id);
      removed.push(run.id);
    }
    return removed;
  }

  putRun(run: AttackRun): Promise<AttackRun> {
    return this.runs.put(run);
  }

  // Returns null when the run does not exist. Returning the same object skips the write.
  updateRun(
    runId: string,
    updater: (current: AttackRun) => AttackRun | Promise<AttackRun>,
  ): Promise<AttackRun | null> {
    return this.runs.update(runId, updater);
  }
}
