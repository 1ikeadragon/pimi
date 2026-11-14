import { useCallback, useMemo } from "react";
import type { TaskStatus } from "@pimi/protocol/task/types";
import type { TaskMenuActions } from "@/components/tasks/task-menu";
import { useToast } from "@/contexts/toast-context";
import { useTaskMutations } from "@/hooks/use-task-mutations";
import { useTranslation } from "@/i18n/use-translation";
import { pushPimiTask } from "@/navigation/pimi-tasks";
import type { AggregatedTask } from "@/tasks/aggregated-tasks";
import { startTaskChat } from "@/tasks/start-task-chat";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";

export interface TaskItemController {
  actions: TaskMenuActions;
  onOpen: () => void;
  onToggleDone: () => void;
}

/** Binds one task's actions to its own host, so a mixed-host list mutates the right daemon. */
export function useTaskItem(task: AggregatedTask): TaskItemController {
  const { t } = useTranslation();
  const toast = useToast();
  const mutations = useTaskMutations({ serverId: task.serverId });
  const { serverId, id, title, description, status } = task;

  const fail = useCallback(
    (error: unknown) => toast.error(toErrorMessage(error) || t("tasks.errors.mutate")),
    [t, toast],
  );

  const onOpen = useCallback(() => pushPimiTask(serverId, id), [id, serverId]);

  const onSetStatus = useCallback(
    (next: TaskStatus) => {
      mutations.updateTask(id, { status: next }).catch(fail);
    },
    [fail, id, mutations],
  );

  const onToggleDone = useCallback(
    () => onSetStatus(status === "done" ? "todo" : "done"),
    [onSetStatus, status],
  );

  const onStartChat = useCallback(() => {
    startTaskChat({
      serverId,
      task: { title, description },
      link: (agentId) => mutations.setTaskLink(id, { kind: "agent", agentId }, true),
    });
  }, [description, id, mutations, serverId, title]);

  const onDelete = useCallback(() => {
    void (async () => {
      const confirmed = await confirmDialog({
        title: t("tasks.delete.title"),
        message: t("tasks.delete.message", { title }),
        confirmLabel: t("tasks.delete.confirm"),
        destructive: true,
      });
      if (!confirmed) return;
      mutations.deleteTask(id).catch(fail);
    })();
  }, [fail, id, mutations, t, title]);

  const actions = useMemo<TaskMenuActions>(
    () => ({ onEdit: onOpen, onSetStatus, onStartChat, onDelete }),
    [onDelete, onOpen, onSetStatus, onStartChat],
  );
  return { actions, onOpen, onToggleDone };
}
