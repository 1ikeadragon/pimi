import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import {
  AutomationRunSchema,
  AutomationSchema,
  type Automation,
  type AutomationRun,
} from "@pimi/protocol/automation/types";
import { JsonRecordStore } from "../json-record-store.js";

const RUN_RETENTION_COUNT = 50;
const RUN_RETENTION_MS = 30 * 24 * 60 * 60_000;

// $PASEO_HOME/automations/<id>.json and $PASEO_HOME/automations/runs/<automationId>/<runId>.json
export class AutomationStore {
  readonly dir: string;
  private readonly logger: Logger;
  readonly automations: JsonRecordStore<Automation>;
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
    this.runStores.delete(automationId);
    await rm(join(this.dir, "runs", automationId), { recursive: true, force: true });
  }
}
