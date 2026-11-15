import type { Logger } from "pino";
import { FlowRunSchema, FlowSchema, type Flow, type FlowRun } from "@pimi/protocol/flow/types";
import type { PimiDatabase } from "../db/pimi-db.js";
import { SqlRecordStore } from "../db/sql-record-store.js";

// Runs kept per flow; a running run is never dropped.
const RUNS_KEPT_PER_FLOW = 30;

// Rows in pimi.db: kinds `flow` and `flow_run`. Flows are host-wide, not tied to a project.
export class FlowStore {
  readonly flows: SqlRecordStore<Flow>;
  readonly runs: SqlRecordStore<FlowRun>;

  constructor(options: { database: PimiDatabase; logger: Logger }) {
    this.flows = new SqlRecordStore({
      database: options.database,
      kind: "flow",
      schema: FlowSchema,
      logger: options.logger,
      label: "flow",
    });
    this.runs = new SqlRecordStore({
      database: options.database,
      kind: "flow_run",
      schema: FlowRunSchema,
      logger: options.logger,
      label: "flow run",
    });
  }

  async listRuns(flowId: string): Promise<FlowRun[]> {
    const runs = await this.runs.list();
    return runs
      .filter((run) => run.flowId === flowId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  async pruneRuns(flowId: string): Promise<void> {
    const runs = await this.listRuns(flowId);
    await Promise.all(
      runs
        .slice(RUNS_KEPT_PER_FLOW)
        .filter((run) => run.status !== "running")
        .map((run) => this.runs.delete(run.id)),
    );
  }

  async deleteFlow(flowId: string): Promise<void> {
    for (const run of await this.listRuns(flowId)) {
      await this.runs.delete(run.id);
    }
    await this.flows.delete(flowId);
  }
}
