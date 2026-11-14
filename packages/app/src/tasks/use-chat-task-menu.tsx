import { useCallback, useMemo, type ReactElement } from "react";
import { ListPlus, ListTodo } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { TASK_TITLE_MAX_LENGTH } from "@pimi/protocol/task/types";
import { resolveChatTitle, useWorkspacePrimaryChat } from "@/chats/primary-chat";
import { DropdownMenuSubTrigger } from "@/components/ui/dropdown-menu";
import { MenuHint, MenuItem, type MenuPageDefinition } from "@/components/ui/menu";
import { useToast } from "@/contexts/toast-context";
import { useTaskMutations } from "@/hooks/use-task-mutations";
import { useTasks } from "@/hooks/use-tasks";
import { useTranslation } from "@/i18n/use-translation";
import { pushPimiTask } from "@/navigation/pimi-tasks";
import type { AggregatedTask } from "@/tasks/aggregated-tasks";
import type { Theme } from "@/styles/theme";
import { toErrorMessage } from "@/utils/error-messages";

export const ADD_TO_TASK_PAGE_ID = "addToTask";

const ThemedListPlus = withUnistyles(ListPlus);
const ThemedListTodo = withUnistyles(ListTodo);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ADD_ICON = <ThemedListPlus size={16} uniProps={mutedMapping} />;
const NEW_ICON = <ThemedListTodo size={16} uniProps={mutedMapping} />;
const NO_PAGES: readonly MenuPageDefinition[] = [];

/**
 * "Add to task" and "New task from chat" for a workspace's primary chat, for the menus that act
 * on a chat (the sidebar row and the chat header). The task list is read only while the page is
 * open, so a closed menu costs nothing. Rows are null while the workspace has no chat.
 */
export function useChatTaskMenu(
  serverId: string,
  workspaceId: string,
): { pages: readonly MenuPageDefinition[]; rows: ReactElement | null } {
  const { t } = useTranslation();
  const toast = useToast();
  const chat = useWorkspacePrimaryChat(serverId, workspaceId);
  const agentId = chat?.agentId ?? null;
  const chatTitle = chat?.title ?? null;
  const mutations = useTaskMutations({ serverId });

  const createFromChat = useCallback(() => {
    if (!agentId) return;
    const title = resolveChatTitle({
      primaryTitle: chatTitle,
      workspaceTitle: null,
      fallback: t("tasks.newTask"),
    }).slice(0, TASK_TITLE_MAX_LENGTH);
    mutations
      .createTask({ title, links: [{ kind: "agent", agentId, role: "creator" }] })
      .then(({ task }) => pushPimiTask(serverId, task.id))
      .catch((error: unknown) => toast.error(toErrorMessage(error) || t("tasks.errors.mutate")));
  }, [agentId, chatTitle, mutations, serverId, t, toast]);

  const pages = useMemo<readonly MenuPageDefinition[]>(
    () =>
      agentId
        ? [
            {
              id: ADD_TO_TASK_PAGE_ID,
              title: t("labels.chat.addToTask"),
              content: <AddToTaskPage serverId={serverId} agentId={agentId} />,
            },
          ]
        : NO_PAGES,
    [agentId, serverId, t],
  );
  const rows = useMemo(
    () =>
      agentId ? (
        <>
          <DropdownMenuSubTrigger
            id={ADD_TO_TASK_PAGE_ID}
            leading={ADD_ICON}
            testID="chat-menu-add-to-task"
          >
            {t("labels.chat.addToTask")}
          </DropdownMenuSubTrigger>
          <MenuItem leading={NEW_ICON} onSelect={createFromChat} testID="chat-menu-new-task">
            {t("labels.chat.newTaskFromChat")}
          </MenuItem>
        </>
      ) : null,
    [agentId, createFromChat, t],
  );
  return { pages, rows };
}

function AddToTaskPage({ serverId, agentId }: { serverId: string; agentId: string }): ReactElement {
  const { t } = useTranslation();
  const { loadState } = useTasks();
  const open = useMemo(
    () =>
      loadState.status === "loaded"
        ? loadState.data.filter((task) => task.serverId === serverId && task.status !== "done")
        : [],
    [loadState, serverId],
  );
  if (open.length === 0) {
    return <MenuHint testID="chat-menu-no-open-tasks">{t("labels.chat.noOpenTasks")}</MenuHint>;
  }
  return (
    <>
      {open.map((task) => (
        <AddToTaskRow key={task.id} serverId={serverId} agentId={agentId} task={task} />
      ))}
    </>
  );
}

function AddToTaskRow({
  serverId,
  agentId,
  task,
}: {
  serverId: string;
  agentId: string;
  task: AggregatedTask;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const mutations = useTaskMutations({ serverId });
  const linked = task.links.some((entry) => entry.kind === "agent" && entry.agentId === agentId);
  const link = useCallback(() => {
    mutations
      .setTaskLink(task.id, { kind: "agent", agentId }, true)
      .catch((error: unknown) => toast.error(toErrorMessage(error) || t("tasks.errors.mutate")));
  }, [agentId, mutations, t, task.id, toast]);
  return (
    <MenuItem
      disabled={linked}
      selected={linked}
      onSelect={link}
      testID={`chat-menu-task-${task.id}`}
    >
      {task.title}
    </MenuItem>
  );
}
