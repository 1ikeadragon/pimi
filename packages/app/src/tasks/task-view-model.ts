import type { Label } from "@pimi/protocol/labels";
import { labelTargetKey } from "@pimi/protocol/labels";
import type { TaskStatus } from "@pimi/protocol/task/types";
import type { AggregatedTask } from "@/tasks/aggregated-tasks";
import type { HostLabelIndex } from "@/labels";

export type TaskBucket = "open" | "done";
export type TaskGroupBy = "status" | "label" | "none";
export type TaskViewMode = "list" | "board";

export const OPEN_STATUSES: readonly TaskStatus[] = ["todo", "in_progress"];
export const BOARD_STATUSES: readonly TaskStatus[] = ["todo", "in_progress", "done"];
export const UNLABELLED_GROUP_ID = "";

export function taskKey(task: { serverId: string; id: string }): string {
  return `${task.serverId}:${task.id}`;
}

export function bucketOf(task: { status: TaskStatus }): TaskBucket {
  return task.status === "done" ? "done" : "open";
}

export interface TaskGroup {
  id: string;
  /** Present for a status group. */
  status?: TaskStatus;
  /** Present for a label group. */
  label?: Label;
  tasks: AggregatedTask[];
}

export function taskLabelIds(
  index: ReadonlyMap<string, HostLabelIndex>,
  task: { serverId: string; id: string },
): readonly string[] {
  return (
    index.get(task.serverId)?.byTarget.get(labelTargetKey({ kind: "task", taskId: task.id })) ?? []
  );
}

/** A label filter value is `serverId:labelId` so identically named labels on two hosts stay apart. */
export function labelFilterValue(serverId: string, labelId: string): string {
  return `${serverId}:${labelId}`;
}

/** Newest activity first; done tasks by completion. */
function compareTasks(a: AggregatedTask, b: AggregatedTask): number {
  const left = a.status === "done" ? (a.completedAt ?? a.updatedAt) : a.createdAt;
  const right = b.status === "done" ? (b.completedAt ?? b.updatedAt) : b.createdAt;
  return Date.parse(right) - Date.parse(left);
}

export function filterTasks(input: {
  tasks: readonly AggregatedTask[];
  selectedHost: string | null;
  bucket: TaskBucket | "all";
  labelFilter: readonly string[];
  labelIndex: ReadonlyMap<string, HostLabelIndex>;
}): AggregatedTask[] {
  const wanted = new Set(input.labelFilter);
  return input.tasks
    .filter((task) => {
      if (input.selectedHost && task.serverId !== input.selectedHost) return false;
      if (input.bucket !== "all" && bucketOf(task) !== input.bucket) return false;
      if (wanted.size > 0) {
        const ids = taskLabelIds(input.labelIndex, task);
        if (!ids.some((id) => wanted.has(labelFilterValue(task.serverId, id)))) return false;
      }
      return true;
    })
    .sort(compareTasks);
}

export function groupTasks(input: {
  tasks: readonly AggregatedTask[];
  groupBy: TaskGroupBy;
  bucket: TaskBucket;
  labelIndex: ReadonlyMap<string, HostLabelIndex>;
}): TaskGroup[] {
  const { tasks, groupBy, bucket, labelIndex } = input;
  if (groupBy === "none") {
    return tasks.length > 0 ? [{ id: "all", tasks: [...tasks] }] : [];
  }
  if (groupBy === "status") {
    const statuses: readonly TaskStatus[] = bucket === "done" ? ["done"] : OPEN_STATUSES;
    return statuses
      .map((status) => ({
        id: status,
        status,
        tasks: tasks.filter((task) => task.status === status),
      }))
      .filter((group) => group.tasks.length > 0);
  }
  // A task with two labels appears under both.
  const byLabel = new Map<string, TaskGroup>();
  const unlabelled: AggregatedTask[] = [];
  for (const task of tasks) {
    const ids = taskLabelIds(labelIndex, task);
    const defs = (labelIndex.get(task.serverId)?.labels ?? []).filter((label) =>
      ids.includes(label.id),
    );
    if (defs.length === 0) {
      unlabelled.push(task);
      continue;
    }
    for (const label of defs) {
      const key = labelFilterValue(task.serverId, label.id);
      const group = byLabel.get(key) ?? { id: key, label, tasks: [] };
      group.tasks.push(task);
      byLabel.set(key, group);
    }
  }
  const groups = [...byLabel.values()].sort((a, b) =>
    (a.label?.name ?? "").localeCompare(b.label?.name ?? ""),
  );
  if (unlabelled.length > 0) {
    groups.push({ id: UNLABELLED_GROUP_ID, tasks: unlabelled });
  }
  return groups;
}

export function boardColumns(tasks: readonly AggregatedTask[]): TaskGroup[] {
  return BOARD_STATUSES.map((status) => ({
    id: status,
    status,
    tasks: tasks.filter((task) => task.status === status),
  }));
}
