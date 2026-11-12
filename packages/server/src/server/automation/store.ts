import { join } from "node:path";
import type { Logger } from "pino";
import {
  AutomationAuditEntrySchema,
  AutomationDraftSchema,
  AutomationRunSchema,
  AutomationSchema,
  type Automation,
  type AutomationDraft,
  type AutomationRun,
} from "@pimi/protocol/automation/types";
import { runJsonImportOnce, type PimiDatabase } from "../db/pimi-db.js";
import {
  SqlRecordStore,
  insertAudit,
  insertRecord,
  listDirs,
  readLegacyJsonDir,
  readLegacyJsonLines,
} from "../db/sql-record-store.js";
import {
  PullRequestTriggerStateSchema,
  type PullRequestTriggerState,
} from "./pull-request-trigger.js";

const RUN_RETENTION_COUNT = 50;
const RUN_RETENTION_MS = 30 * 24 * 60 * 60_000;

interface LegacyFlow {
  nodes?: Array<{ kind?: string; id?: string }>;
  edges?: Array<{ from?: string; to?: string }>;
}

// COMPAT(automation-output-node): automations saved by 0.17.18 and earlier end their flow in a
// `{ kind: "output" }` chat node that no longer exists. Drop it and its edges while importing.
function dropOutputNodes(json: unknown): unknown {
  const record = json as { flow?: LegacyFlow };
  const nodes = record.flow?.nodes;
  if (!record.flow || !Array.isArray(nodes) || !nodes.some((node) => node.kind === "output")) {
    return json;
  }
  const dropped = new Set(nodes.filter((node) => node.kind === "output").map((node) => node.id));
  return {
    ...record,
    flow: {
      nodes: nodes.filter((node) => node.kind !== "output"),
      edges: (record.flow.edges ?? []).filter(
        (edge) => !dropped.has(edge.from) && !dropped.has(edge.to),
      ),
    },
  };
}

// Rows in pimi.db: kinds automation, automation_run (parent = automation id),
// automation_trigger (id = automation id, pull-request trigger state) and automation_draft
// (descriptions compiling in the background). `legacyDir` is the old $PIMI_HOME/automations tree,
// imported once and renamed to automations.migrated.
export class AutomationStore {
  private readonly logger: Logger;
  private readonly database: PimiDatabase;
  private readonly legacyDir: string;
  readonly automations: SqlRecordStore<Automation>;
  readonly triggerStates: SqlRecordStore<PullRequestTriggerState>;
  readonly drafts: SqlRecordStore<AutomationDraft>;
  private readonly runStores = new Map<string, SqlRecordStore<AutomationRun>>();

  constructor(options: { database: PimiDatabase; legacyDir: string; logger: Logger }) {
    this.database = options.database;
    this.legacyDir = options.legacyDir;
    this.logger = options.logger;
    this.automations = new SqlRecordStore({
      database: this.database,
      kind: "automation",
      schema: AutomationSchema,
      logger: this.logger,
      label: "automation",
    });
    this.triggerStates = new SqlRecordStore({
      database: this.database,
      kind: "automation_trigger",
      schema: PullRequestTriggerStateSchema,
      logger: this.logger,
      label: "automation trigger state",
    });
    this.drafts = new SqlRecordStore({
      database: this.database,
      kind: "automation_draft",
      schema: AutomationDraftSchema,
      logger: this.logger,
      label: "automation draft",
    });
  }

  async importLegacy(): Promise<void> {
    const dir = this.legacyDir;
    const automations = await readLegacyJsonDir(
      dir,
      AutomationSchema,
      this.logger,
      dropOutputNodes,
    );
    const triggers = await readLegacyJsonDir(
      join(dir, "triggers"),
      PullRequestTriggerStateSchema,
      this.logger,
    );
    const drafts = await readLegacyJsonDir(join(dir, "drafts"), AutomationDraftSchema, this.logger);
    const runs: AutomationRun[] = [];
    for (const automationId of await listDirs(join(dir, "runs"))) {
      runs.push(
        ...(await readLegacyJsonDir(
          join(dir, "runs", automationId),
          AutomationRunSchema,
          this.logger,
        )),
      );
    }
    const audit = [
      ...(await readLegacyJsonLines(join(dir, "audit.1.jsonl"), AutomationAuditEntrySchema)),
      ...(await readLegacyJsonLines(join(dir, "audit.jsonl"), AutomationAuditEntrySchema)),
    ];
    await runJsonImportOnce(
      this.database,
      { name: "automations", legacyPaths: [dir], logger: this.logger },
      () => {
        for (const item of automations)
          insertRecord(this.database, "automation", null, item.id, item);
        for (const item of triggers) {
          insertRecord(this.database, "automation_trigger", null, item.id, item);
        }
        for (const item of drafts)
          insertRecord(this.database, "automation_draft", null, item.id, item);
        for (const run of runs) {
          insertRecord(this.database, "automation_run", run.automationId, run.id, run);
        }
        for (const entry of audit) {
          insertAudit(this.database, `automation:${entry.automationId}`, entry.at, entry);
        }
      },
    );
  }

  runs(automationId: string): SqlRecordStore<AutomationRun> {
    if (!/^[A-Za-z0-9_-]+$/.test(automationId)) {
      throw new Error(`Invalid automation id: ${automationId}`);
    }
    let store = this.runStores.get(automationId);
    if (!store) {
      store = new SqlRecordStore({
        database: this.database,
        kind: "automation_run",
        parentId: automationId,
        schema: AutomationRunSchema,
        logger: this.logger,
        label: "automation run",
      });
      this.runStores.set(automationId, store);
    }
    return store;
  }

  async listRuns(automationId: string): Promise<AutomationRun[]> {
    const runs = await this.runs(automationId).list();
    return runs.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  // Keep the newest 50 runs and nothing older than 30 days. A running run is never dropped.
  // Returns the dropped runs so the caller can archive their workspaces.
  async pruneRuns(automationId: string, now: Date): Promise<AutomationRun[]> {
    const runs = await this.listRuns(automationId);
    const cutoff = now.getTime() - RUN_RETENTION_MS;
    const doomed = runs.filter(
      (run, index) =>
        run.status !== "running" &&
        (index >= RUN_RETENTION_COUNT || new Date(run.startedAt).getTime() < cutoff),
    );
    await Promise.all(doomed.map((run) => this.runs(automationId).delete(run.id)));
    return doomed;
  }

  async deleteAutomation(automationId: string): Promise<void> {
    await this.automations.delete(automationId);
    await this.triggerStates.delete(automationId);
    this.runs(automationId).deleteAll();
    this.runStores.delete(automationId);
  }
}
