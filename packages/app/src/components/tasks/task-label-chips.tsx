import { memo, useMemo, type ReactElement } from "react";
import { LabelChips } from "@/labels";
import type { AggregatedTask } from "@/tasks/aggregated-tasks";

/** The task's labels, resolved against its own host. */
export const TaskLabelChips = memo(function TaskLabelChips({
  task,
}: {
  task: Pick<AggregatedTask, "id" | "serverId">;
}): ReactElement {
  const target = useMemo(() => ({ kind: "task" as const, taskId: task.id }), [task.id]);
  return <LabelChips serverId={task.serverId} target={target} />;
});
