import { useCallback, useMemo } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@pimi/client/internal/daemon-client";
import type {
  Task,
  TaskCreateInput,
  TaskLinkTarget,
  TaskUpdateInput,
} from "@pimi/protocol/task/types";
import {
  tasksQueryBaseKey,
  type AggregatedTask,
  type FetchAggregatedTasksState,
} from "@/tasks/aggregated-tasks";
import { useSessionStore } from "@/stores/session-store";
import { i18n } from "@/i18n/i18next";

export interface TaskCreateResult {
  task: Task;
  /** False when the daemon returned an existing task (same creator, same title, not done). */
  created: boolean;
}

export interface TaskMutations {
  createTask: (input: TaskCreateInput) => Promise<TaskCreateResult>;
  updateTask: (taskId: string, update: TaskUpdateInput) => Promise<Task>;
  deleteTask: (taskId: string) => Promise<void>;
  /** Linking an already linked target, or unlinking an unlinked one, changes nothing. */
  setTaskLink: (taskId: string, target: TaskLinkTarget, linked: boolean) => Promise<Task>;
}

function requireClient(serverId: string): DaemonClient {
  const client = useSessionStore.getState().sessions[serverId]?.client ?? null;
  if (!client) {
    throw new Error(i18n.t("common.errors.daemonClientUnavailable"));
  }
  return client;
}

type Snapshot = Array<[readonly unknown[], FetchAggregatedTasksState | undefined]>;

function patchTasks(
  queryClient: QueryClient,
  patch: (tasks: AggregatedTask[]) => AggregatedTask[],
): Snapshot {
  const previous = queryClient.getQueriesData<FetchAggregatedTasksState>({
    queryKey: tasksQueryBaseKey,
  });
  queryClient.setQueriesData<FetchAggregatedTasksState>(
    { queryKey: tasksQueryBaseKey },
    (current) =>
      current && current.status === "loaded" ? { ...current, data: patch(current.data) } : current,
  );
  return previous;
}

function restore(queryClient: QueryClient, snapshot: Snapshot): void {
  for (const [key, data] of snapshot) queryClient.setQueryData(key, data);
}

/**
 * Task writes against one host. Status changes and deletes patch the cached list first so a row
 * moves the moment it is pressed; every write ends by refetching, which is the source of truth.
 * The daemon also pushes `status.tasks_changed`, so other clients converge without polling.
 */
export function useTaskMutations({ serverId }: { serverId: string }): TaskMutations {
  const queryClient = useQueryClient();

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: tasksQueryBaseKey });
  }, [queryClient]);

  const createTask = useCallback(
    async (input: TaskCreateInput): Promise<TaskCreateResult> => {
      try {
        const { task, created } = await requireClient(serverId).taskCreate({ task: input });
        // Callers open the new task right away; the list must hold it first, or its sheet reports
        // "no longer exists". "all" also refetches a list nobody is observing yet.
        await queryClient.invalidateQueries({ queryKey: tasksQueryBaseKey, refetchType: "all" });
        return { task, created };
      } catch (error) {
        invalidate();
        throw error;
      }
    },
    [invalidate, queryClient, serverId],
  );

  const updateTask = useCallback(
    async (taskId: string, update: TaskUpdateInput): Promise<Task> => {
      await queryClient.cancelQueries({ queryKey: tasksQueryBaseKey });
      // The PR URL is agent-set; its null (clear) form needs the daemon's projection, not this patch.
      const { pullRequestUrl: _pullRequestUrl, ...optimistic } = update;
      const snapshot = patchTasks(queryClient, (tasks) =>
        tasks.map((task) =>
          task.serverId === serverId && task.id === taskId ? { ...task, ...optimistic } : task,
        ),
      );
      try {
        return (await requireClient(serverId).taskUpdate({ taskId, update })).task;
      } catch (error) {
        restore(queryClient, snapshot);
        throw error;
      } finally {
        invalidate();
      }
    },
    [invalidate, queryClient, serverId],
  );

  const deleteTask = useCallback(
    async (taskId: string): Promise<void> => {
      await queryClient.cancelQueries({ queryKey: tasksQueryBaseKey });
      const snapshot = patchTasks(queryClient, (tasks) =>
        tasks.filter((task) => !(task.serverId === serverId && task.id === taskId)),
      );
      try {
        await requireClient(serverId).taskDelete({ taskId });
      } catch (error) {
        restore(queryClient, snapshot);
        throw error;
      } finally {
        invalidate();
      }
    },
    [invalidate, queryClient, serverId],
  );

  const setTaskLink = useCallback(
    async (taskId: string, target: TaskLinkTarget, linked: boolean): Promise<Task> => {
      try {
        return (await requireClient(serverId).taskLinkSet({ taskId, target, linked })).task;
      } finally {
        invalidate();
      }
    },
    [invalidate, serverId],
  );

  return useMemo(
    () => ({ createTask, updateTask, deleteTask, setTaskLink }),
    [createTask, updateTask, deleteTask, setTaskLink],
  );
}
