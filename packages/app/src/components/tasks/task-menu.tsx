import {
  ArrowRight,
  MessageSquarePlus,
  MoreVertical,
  Pencil,
  Tag,
  Trash2,
} from "lucide-react-native";
import { useCallback, useMemo, type ReactElement } from "react";
import type { PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { TaskStatus } from "@pimi/protocol/task/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isNative } from "@/constants/platform";
import { LABEL_PAGE_ID, useLabelMenuPages } from "@/labels";
import { useTranslation } from "@/i18n/use-translation";
import type { Theme } from "@/styles/theme";
import { BOARD_STATUSES } from "@/tasks/task-view-model";
import type { AggregatedTask } from "@/tasks/aggregated-tasks";

const ThemedKebab = withUnistyles(MoreVertical);
const ThemedPencil = withUnistyles(Pencil);
const ThemedTag = withUnistyles(Tag);
const ThemedArrowRight = withUnistyles(ArrowRight);
const ThemedMessagePlus = withUnistyles(MessageSquarePlus);
const ThemedTrash = withUnistyles(Trash2);

const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const destructiveMapping = (theme: Theme) => ({ color: theme.colors.destructive });

const MENU_ICON_SIZE = 14;

const editLeading = <ThemedPencil size={MENU_ICON_SIZE} uniProps={mutedMapping} />;
const labelsLeading = <ThemedTag size={MENU_ICON_SIZE} uniProps={mutedMapping} />;
const moveLeading = <ThemedArrowRight size={MENU_ICON_SIZE} uniProps={mutedMapping} />;
const startChatLeading = <ThemedMessagePlus size={MENU_ICON_SIZE} uniProps={mutedMapping} />;
const deleteLeading = <ThemedTrash size={MENU_ICON_SIZE} uniProps={destructiveMapping} />;

function renderKebabIcon({ hovered }: { hovered?: boolean }): ReactElement {
  return (
    <ThemedKebab size={MENU_ICON_SIZE} uniProps={hovered ? foregroundMapping : mutedMapping} />
  );
}

export interface TaskMenuActions {
  onEdit: () => void;
  onSetStatus: (status: TaskStatus) => void;
  onStartChat: () => void;
  onDelete: () => void;
}

export function TaskKebabMenu({
  task,
  actions,
  testIDPrefix = "task",
}: {
  task: AggregatedTask;
  actions: TaskMenuActions;
  testIDPrefix?: string;
}): ReactElement {
  const { t } = useTranslation();
  const target = useMemo(() => ({ kind: "task" as const, taskId: task.id }), [task.id]);
  const pages = useLabelMenuPages(task.serverId, target);
  const statusLabels: Record<TaskStatus, string> = {
    todo: t("tasks.menu.markTodo"),
    in_progress: t("tasks.menu.markInProgress"),
    done: t("tasks.menu.markDone"),
  };
  return (
    <DropdownMenu compactMode="sheet">
      <DropdownMenuTrigger
        hitSlop={8}
        style={kebabTriggerStyle}
        accessibilityRole={isNative ? "button" : undefined}
        accessibilityLabel={t("tasks.row.actions")}
        testID={`${testIDPrefix}-kebab-${task.id}`}
      >
        {renderKebabIcon}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        width={220}
        pages={pages}
        sheetTitle={t("tasks.row.actions")}
      >
        <DropdownMenuItem
          leading={editLeading}
          onSelect={actions.onEdit}
          testID={`${testIDPrefix}-menu-edit-${task.id}`}
        >
          {t("tasks.menu.edit")}
        </DropdownMenuItem>
        {BOARD_STATUSES.filter((status) => status !== task.status).map((status) => (
          <MoveItem
            key={status}
            status={status}
            label={statusLabels[status]}
            onSetStatus={actions.onSetStatus}
            testID={`${testIDPrefix}-menu-${status}-${task.id}`}
          />
        ))}
        <DropdownMenuSubTrigger
          id={LABEL_PAGE_ID}
          leading={labelsLeading}
          testID={`${testIDPrefix}-menu-labels-${task.id}`}
        >
          {t("tasks.menu.labels")}
        </DropdownMenuSubTrigger>
        <DropdownMenuItem
          leading={startChatLeading}
          onSelect={actions.onStartChat}
          testID={`${testIDPrefix}-menu-start-chat-${task.id}`}
        >
          {t("tasks.menu.startChat")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          leading={deleteLeading}
          destructive
          onSelect={actions.onDelete}
          testID={`${testIDPrefix}-menu-delete-${task.id}`}
        >
          {t("tasks.menu.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MoveItem({
  status,
  label,
  onSetStatus,
  testID,
}: {
  status: TaskStatus;
  label: string;
  onSetStatus: (status: TaskStatus) => void;
  testID: string;
}): ReactElement {
  const select = useCallback(() => onSetStatus(status), [onSetStatus, status]);
  return (
    <DropdownMenuItem leading={moveLeading} onSelect={select} testID={testID}>
      {label}
    </DropdownMenuItem>
  );
}

function kebabTriggerStyle({
  hovered = false,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.kebabTrigger, hovered && styles.kebabTriggerHovered];
}

const styles = StyleSheet.create((theme) => ({
  kebabTrigger: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
  },
  kebabTriggerHovered: { backgroundColor: theme.colors.surface2 },
}));
