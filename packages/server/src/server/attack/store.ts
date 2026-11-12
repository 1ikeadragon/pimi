import { chmod, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import {
  AttackRunSchema,
  FindingSchema,
  type AttackRun,
  type Finding,
} from "@pimi/protocol/attack/types";
import { writeJsonFileAtomic } from "../atomic-file.js";
import { JsonRecordStore } from "../json-record-store.js";
import { AttackAuditLog } from "./audit.js";

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

// Same trade as JsonRecordStore: scan once, then serve from memory; a minute-old cache at most.
const RUNS_REVALIDATE_MS = 60_000;
// A finished run (stopped or completed) is dropped only once it is both older than this and
// outside the newest FINISHED_RUNS_KEPT finished runs. 90 days is a quarter: long enough to
// re-open a past report or fix its findings; the count keeps a quiet user's last reports even
// after months away.
const FINISHED_RUN_RETENTION_MS = 90 * 24 * 60 * 60_000;
const FINISHED_RUNS_KEPT = 25;

function assertId(id: string): void {
  if (!ID_PATTERN.test(id)) throw new Error(`Invalid attack run id: ${id}`);
}

// $PIMI_HOME/attack-runs/<runId>/run.json, findings/<findingId>.json and audit.jsonl.
export class AttackStore {
  readonly dir: string;
  private readonly logger: Logger;
  private readonly findingStores = new Map<string, JsonRecordStore<Finding>>();
  private readonly auditLogs = new Map<string, AttackAuditLog>();
  private readonly mutations = new Map<string, Promise<unknown>>();
  private runsCache: Map<string, AttackRun> | null = null;
  private runsCachedAt = 0;
  private runsLoading: Promise<Map<string, AttackRun>> | null = null;
  private runsWriteVersion = 0;

  constructor(options: { dir: string; logger: Logger }) {
    this.dir = options.dir;
    this.logger = options.logger;
  }

  private runDir(runId: string): string {
    assertId(runId);
    return join(this.dir, runId);
  }

  private runPath(runId: string): string {
    return join(this.runDir(runId), "run.json");
  }

  findings(runId: string): JsonRecordStore<Finding> {
    let store = this.findingStores.get(runId);
    if (!store) {
      store = new JsonRecordStore({
        dir: join(this.runDir(runId), "findings"),
        schema: FindingSchema,
        logger: this.logger,
        label: "attack finding",
      });
      this.findingStores.set(runId, store);
    }
    return store;
  }

  audit(runId: string): AttackAuditLog {
    let log = this.auditLogs.get(runId);
    if (!log) {
      log = new AttackAuditLog({ dir: this.runDir(runId), logger: this.logger });
      this.auditLogs.set(runId, log);
    }
    return log;
  }

  async getRun(runId: string): Promise<AttackRun | null> {
    try {
      return AttackRunSchema.parse(JSON.parse(await readFile(this.runPath(runId), "utf-8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async listRuns(): Promise<AttackRun[]> {
    let runs = this.runsCache;
    if (!runs || Date.now() - this.runsCachedAt > RUNS_REVALIDATE_MS) {
      this.runsLoading ??= this.scanRuns().finally(() => {
        this.runsLoading = null;
      });
      runs = await this.runsLoading;
    }
    // Callers own what they get back; a clone keeps them from editing the cache.
    return [...runs.values()]
      .map((run) => structuredClone(run))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  private async scanRuns(): Promise<Map<string, AttackRun>> {
    const version = this.runsWriteVersion;
    const runs = new Map<string, AttackRun>();
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return runs;
      throw error;
    }
    for (const name of entries) {
      if (!ID_PATTERN.test(name)) continue;
      try {
        const run = await this.getRun(name);
        if (run) runs.set(name, run);
      } catch (error) {
        this.logger.error({ err: error, runId: name }, "Skipping invalid attack run file");
      }
    }
    // A write that landed during the scan may not be in `runs`; leave the cache empty then.
    if (version === this.runsWriteVersion) {
      this.runsCache = runs;
      this.runsCachedAt = Date.now();
    }
    return runs;
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
    for (const run of doomed) {
      await this.serialize(run.id, async () => {
        // Re-read under the lock: a run resumed since the listing must survive.
        const current = await this.getRun(run.id);
        if (!current || (current.status !== "stopped" && current.status !== "completed")) return;
        await rm(this.runDir(run.id), { recursive: true, force: true });
        this.runsWriteVersion += 1;
        this.runsCache?.delete(run.id);
        this.findingStores.delete(run.id);
        this.auditLogs.delete(run.id);
      });
    }
    return doomed.map((run) => run.id);
  }

  putRun(run: AttackRun): Promise<AttackRun> {
    return this.serialize(run.id, () => this.writeRun(run));
  }

  // Returns null when the run does not exist. Returning the same object skips the write.
  updateRun(
    runId: string,
    updater: (current: AttackRun) => AttackRun | Promise<AttackRun>,
  ): Promise<AttackRun | null> {
    return this.serialize(runId, async () => {
      const current = await this.getRun(runId);
      if (!current) return null;
      const next = await updater(current);
      if (next === current) return current;
      if (next.id !== runId) throw new Error(`attack run update cannot change id: ${runId}`);
      return this.writeRun(next);
    });
  }

  private async writeRun(run: AttackRun): Promise<AttackRun> {
    const parsed = AttackRunSchema.parse(run);
    const dir = this.runDir(parsed.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    await writeJsonFileAtomic(this.runPath(parsed.id), parsed);
    this.runsWriteVersion += 1;
    this.runsCache?.set(parsed.id, structuredClone(parsed));
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
