import { memo, type ReactElement } from "react";
import { TaskRow } from "@/components/tasks/task-row";
import type { AggregatedTask } from "@/tasks/aggregated-tasks";
import {
  chatKey,
  linkedChatId,
  type TaskChatDirectory,
  type TaskChat,
} from "@/tasks/use-chat-directory";
import { useTaskItem } from "@/tasks/use-task-item";

const NO_CHATS: TaskChat[] = [];

/** The chats a task points at, deduplicated: a subagent link resolves to its parent chat. */
export function resolveTaskChats(task: AggregatedTask, directory: TaskChatDirectory): TaskChat[] {
  if (task.links.length === 0) return NO_CHATS;
  const seen = new Set<string>();
  const chats: TaskChat[] = [];
  for (const link of task.links) {
    const key = chatKey(task.serverId, linkedChatId(link));
    const chat = directory.get(key);
    if (!chat || seen.has(key)) continue;
    seen.add(key);
    chats.push(chat);
  }
  return chats;
}

export const TaskListItem = memo(function TaskListItem({
  task,
  directory,
  isFirst,
  showHost,
}: {
  task: AggregatedTask;
  directory: TaskChatDirectory;
  isFirst: boolean;
  showHost: boolean;
}): ReactElement {
  const item = useTaskItem(task);
  return (
    <TaskRow
      task={task}
      chats={resolveTaskChats(task, directory)}
      isFirst={isFirst}
      showHost={showHost}
      actions={item.actions}
      onOpen={item.onOpen}
      onToggleDone={item.onToggleDone}
    />
  );
});
