import { useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import {
  fetchAggregatedTasks,
  tasksQueryBaseKey,
  type AggregatedTask,
  type TaskHostError,
  type TaskHostInput,
  type TaskLoadState,
} from "@/tasks/aggregated-tasks";

export type { AggregatedTask, TaskHostError, TaskHostInput, TaskLoadState };

const NO_HOSTS: TaskHostInput[] = [];
const NO_HOST_ERRORS: TaskHostError[] = [];

export function tasksQueryKey(serverIds: readonly string[]) {
  return [...tasksQueryBaseKey, [...serverIds].sort().join("|")] as const;
}

export interface UseTasksResult {
  loadState: TaskLoadState;
  hostErrors: TaskHostError[];
  /** Hosts still connecting after another host answered. */
  connectingHosts: TaskHostInput[];
  isError: boolean;
  refetch: () => void;
}

/**
 * Keeps the task list current from each online host's `status.tasks_changed` push, including
 * changes made by agents. A subscription snapshot fires on every (re)connect, which catches
 * changes missed while offline.
 */
function useTaskSync(onlineKey: string): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const releases: Array<() => void> = [];
    for (const serverId of onlineKey ? onlineKey.split("|") : []) {
      const client = useSessionStore.getState().sessions[serverId]?.client ?? null;
      if (!client) continue;
      const observation = client.observeEvents(["status.tasks_changed"]);
      const invalidate = () => {
        void queryClient.invalidateQueries({ queryKey: tasksQueryBaseKey });
      };
      observation.subscribe({
        snapshot: invalidate,
        update: (message) => {
          if (message.type === "status" && message.payload.status === "tasks_changed") {
            invalidate();
          }
        },
      });
      releases.push(() => {
        void observation.release().catch(() => undefined);
      });
    }
    return () => {
      for (const release of releases) release();
    };
  }, [onlineKey, queryClient]);
}

export function useTasks(): UseTasksResult {
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const hostInputs = useMemo<TaskHostInput[]>(
    () => hosts.map((host) => ({ serverId: host.serverId, serverName: host.label })),
    [hosts],
  );
  const serverIds = useMemo(() => hostInputs.map((host) => host.serverId), [hostInputs]);
  const statuses = useHostRuntimeConnectionStatuses(serverIds);
  const connectionStatusKey = useMemo(
    () => serverIds.map((serverId) => statuses.get(serverId) ?? "connecting").join("|"),
    [statuses, serverIds],
  );
  const onlineKey = useMemo(
    () => serverIds.filter((serverId) => statuses.get(serverId) === "online").join("|"),
    [statuses, serverIds],
  );
  useTaskSync(onlineKey);

  const query = useFetchQuery({
    queryKey: [...tasksQueryKey(serverIds), connectionStatusKey],
    queryFn: () => fetchAggregatedTasks({ hosts: hostInputs, runtime }),
    dataShape: "list",
    staleTimeMs: 5_000,
  });

  let loadState: TaskLoadState;
  if (query.data?.status === "connecting") {
    loadState = { status: "connecting" };
  } else if (query.data?.status === "loaded") {
    loadState = { status: "loaded", data: query.data.data };
  } else {
    loadState = { status: "loading" };
  }
  return {
    loadState,
    hostErrors: query.data?.status === "loaded" ? query.data.hostErrors : NO_HOST_ERRORS,
    connectingHosts: query.data?.status === "loaded" ? query.data.connectingHosts : NO_HOSTS,
    isError: query.isError,
    refetch: () => {
      void query.refetch();
    },
  };
}
