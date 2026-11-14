import type { Logger } from "pino";
import type { Task } from "@pimi/protocol/task/types";
import type { AgentHandoffServices, AgentManager } from "../agent-manager.js";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import type { SqliteTimelineStore } from "../sqlite-timeline-store.js";
import type { StructuredGenerationDaemonConfig } from "../structured-generation-providers.js";
import { HandoffController } from "./controller.js";
import { HandoffRefresher } from "./refresher.js";
import { createHandoffSummaryModel } from "./summary-model.js";
import type { TranscriptStore } from "./transcript-file.js";
import type { OpenTask } from "./work-state.js";

export interface HandoffServicesDeps {
  transcripts: TranscriptStore;
  archive: SqliteTimelineStore;
  /** The manager and the task list are created after these services, so they are read lazily. */
  manager: () => AgentManager;
  openTasks: (agentId: string) => Promise<OpenTask[]>;
  providerSnapshotManager: Pick<ProviderSnapshotManager, "listProviders">;
  daemonConfig: () => StructuredGenerationDaemonConfig;
  logger: Logger;
}

/** Pimi tasks that are not done and link to the chat, directly or through a provider subagent. */
export async function listOpenTasksForAgent(
  tasks: { list(): Promise<Task[]> },
  agentId: string,
): Promise<OpenTask[]> {
  return (await tasks.list())
    .filter(
      (task) =>
        task.status !== "done" &&
        task.links.some(
          (link) => (link.kind === "agent" ? link.agentId : link.parentAgentId) === agentId,
        ),
    )
    .map((task) => ({ title: task.title, status: task.status }));
}

export function createHandoffServices(deps: HandoffServicesDeps): AgentHandoffServices {
  const createSummaryModel: AgentHandoffServices["createSummaryModel"] = (where) =>
    createHandoffSummaryModel(
      {
        manager: deps.manager(),
        providerSnapshotManager: deps.providerSnapshotManager,
        daemonConfig: deps.daemonConfig,
        logger: deps.logger,
      },
      where,
    );
  return {
    controller: new HandoffController({
      transcripts: deps.transcripts,
      archive: deps.archive,
      readOpenTasks: deps.openTasks,
      logger: deps.logger,
    }),
    refresher: new HandoffRefresher({
      archive: deps.archive,
      createSummaryModel,
      logger: deps.logger,
    }),
    createSummaryModel,
  };
}
