import type { DaemonClient } from "@pimi/client/internal/daemon-client";
import type { Task } from "@pimi/protocol/task/types";
import { toErrorMessage } from "@/utils/error-messages";

export const tasksQueryBaseKey = ["tasks"] as const;

export const ALL_TASK_HOSTS_FAILED_MESSAGE = "No connected hosts could load tasks";

export interface TaskHostInput {
  serverId: string;
  serverName: string;
}

export interface TaskRuntimeSnapshot {
  connectionStatus: string;
}

export interface TaskRuntime {
  getClient(serverId: string): Pick<DaemonClient, "taskList"> | null;
  getSnapshot(serverId: string): TaskRuntimeSnapshot | null | undefined;
}

/** A task tagged with its host, so one flat list can render and mutate across hosts. */
export interface AggregatedTask extends Task {
  serverId: string;
  serverName: string;
}

export interface TaskHostError {
  serverId: string;
  serverName: string;
  message: string;
}

export type TaskLoadState =
  | { status: "connecting" }
  | { status: "loading" }
  | { status: "loaded"; data: AggregatedTask[] };

export type FetchAggregatedTasksState =
  | { status: "connecting" }
  | {
      status: "loaded";
      data: AggregatedTask[];
      hostErrors: TaskHostError[];
      /** Saved hosts that have not connected yet; their tasks are not in `data`. */
      connectingHosts: TaskHostInput[];
    };

function isSettling(snapshot: TaskRuntimeSnapshot | null | undefined): boolean {
  if (!snapshot) return true;
  return snapshot.connectionStatus === "connecting" || snapshot.connectionStatus === "idle";
}

/**
 * Same contract as the automations fetch: `connecting` only while no host can be asked, per-host
 * failures surface as `hostErrors`, and only when every connected host fails does it throw.
 */
export async function fetchAggregatedTasks(input: {
  hosts: readonly TaskHostInput[];
  runtime: TaskRuntime;
}): Promise<FetchAggregatedTasksState> {
  const connectingHosts = input.hosts.filter((host) =>
    isSettling(input.runtime.getSnapshot(host.serverId)),
  );
  const hasAskableHost = input.hosts.some(
    (host) =>
      input.runtime.getSnapshot(host.serverId)?.connectionStatus === "online" &&
      input.runtime.getClient(host.serverId),
  );
  // No host can answer: an empty list here would read as "no tasks" for a host nobody asked.
  if (!hasAskableHost) {
    return { status: "connecting" };
  }

  const tasks: AggregatedTask[] = [];
  const hostErrors: TaskHostError[] = [];
  let attempts = 0;
  await Promise.all(
    input.hosts.map(async (host) => {
      const client = input.runtime.getClient(host.serverId);
      if (!client || input.runtime.getSnapshot(host.serverId)?.connectionStatus !== "online") {
        return;
      }
      attempts += 1;
      try {
        const payload = await client.taskList();
        for (const task of payload.tasks) {
          tasks.push({ ...task, serverId: host.serverId, serverName: host.serverName });
        }
      } catch (error) {
        hostErrors.push({
          serverId: host.serverId,
          serverName: host.serverName,
          message: toErrorMessage(error),
        });
      }
    }),
  );

  if (attempts > 0 && tasks.length === 0 && hostErrors.length === attempts) {
    throw new Error(ALL_TASK_HOSTS_FAILED_MESSAGE);
  }
  return { status: "loaded", data: tasks, hostErrors, connectingHosts };
}
