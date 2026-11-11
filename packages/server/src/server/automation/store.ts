import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import {
  AutomationRunSchema,
  AutomationSchema,
  type Automation,
  type AutomationRun,
} from "@pimi/protocol/automation/types";
import { writeJsonFileAtomic } from "../atomic-file.js";
import { JsonRecordStore } from "../json-record-store.js";
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

// $PASEO_HOME/automations/<id>.json, $PASEO_HOME/automations/runs/<automationId>/<runId>.json,
// and $PASEO_HOME/automations/triggers/<automationId>.json for pull-request trigger state.
export class AutomationStore {
  readonly dir: string;
  private readonly logger: Logger;
  readonly automations: JsonRecordStore<Automation>;
  readonly triggerStates: JsonRecordStore<PullRequestTriggerState>;
  private readonly runStores = new Map<string, JsonRecordStore<AutomationRun>>();

  constructor(options: { dir: string; logger: Logger }) {
    this.dir = options.dir;
    this.logger = options.logger;
    this.automations = new JsonRecordStore({
      dir: this.dir,
      schema: AutomationSchema,
      logger: this.logger,
      label: "automation",
    });
    this.triggerStates = new JsonRecordStore({
      dir: join(this.dir, "triggers"),
      schema: PullRequestTriggerStateSchema,
      logger: this.logger,
      label: "automation trigger state",
    });
  }

  // COMPAT(automation-output-node): automations saved by 0.17.18 and earlier end their flow in a
  // `{ kind: "output" }` chat node that no longer exists. Drop it and its edges in place so those
  // files parse; a flow is now just its steps.
  async migrateOutputNodes(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
    for (const name of entries) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const path = join(this.dir, name);
      try {
        const record = JSON.parse(await readFile(path, "utf-8")) as { flow?: LegacyFlow };
        const nodes = record.flow?.nodes;
        if (
          !record.flow ||
          !Array.isArray(nodes) ||
          !nodes.some((node) => node.kind === "output")
        ) {
          continue;
        }
        const dropped = new Set(
          nodes.filter((node) => node.kind === "output").map((node) => node.id),
        );
        record.flow = {
          nodes: nodes.filter((node) => node.kind !== "output"),
          edges: (record.flow.edges ?? []).filter(
            (edge) => !dropped.has(edge.from) && !dropped.has(edge.to),
          ),
        };
        await writeJsonFileAtomic(path, record);
      } catch (error) {
        this.logger.warn({ err: error, path }, "Failed to migrate automation output node");
      }
    }
  }

  runs(automationId: string): JsonRecordStore<AutomationRun> {
    if (!/^[A-Za-z0-9_-]+$/.test(automationId)) {
      throw new Error(`Invalid automation id: ${automationId}`);
    }
    let store = this.runStores.get(automationId);
    if (!store) {
      store = new JsonRecordStore({
        dir: join(this.dir, "runs", automationId),
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
    this.runStores.delete(automationId);
    await rm(join(this.dir, "runs", automationId), { recursive: true, force: true });
  }
}
