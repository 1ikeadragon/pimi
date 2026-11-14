import { memo, useCallback, useState, type ReactElement } from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StyleSheet } from "react-native-unistyles";
import { TaskDescription } from "@/components/tasks/task-description";
import { TaskLabelChips } from "@/components/tasks/task-label-chips";
import { TaskChatChip } from "@/components/tasks/task-chat-chip";
import { TaskKebabMenu, type TaskMenuActions } from "@/components/tasks/task-menu";
import { TaskStatusMark } from "@/components/tasks/task-status-mark";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useTranslation } from "@/i18n/use-translation";
import { settingsStyles } from "@/styles/settings";
import type { AggregatedTask } from "@/tasks/aggregated-tasks";
import type { TaskChat } from "@/tasks/use-chat-directory";

export interface TaskRowProps {
  task: AggregatedTask;
  chats: readonly TaskChat[];
  isFirst: boolean;
  /** True when the list spans several hosts, so the host name earns a place on the meta line. */
  showHost: boolean;
  actions: TaskMenuActions;
  onOpen: () => void;
  onToggleDone: () => void;
}

/**
 * One task as a settings-card row: status mark, title, optional description line and a meta line
 * of linked chats and labels, with the kebab owning every other action.
 *
 * Hover lives on the outer plain View (docs/hover.md). The row's own press is an absolutely
 * positioned Pressable behind the content, so the mark, the chat chips and the kebab are siblings
 * of it rather than buttons nested in a button.
 */
export const TaskRow = memo(function TaskRow({
  task,
  chats,
  isFirst,
  showHost,
  actions,
  onOpen,
  onToggleDone,
}: TaskRowProps): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const isDone = task.status === "done";

  const pressStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [styles.pressLayer, pressed && styles.rowPressed],
    [],
  );

  return (
    <View
      style={[
        settingsStyles.row,
        styles.row,
        !isFirst && settingsStyles.rowBorder,
        isHovered && !isCompact && styles.rowHovered,
      ]}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <PressHighlight
        style={pressStyle}
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={t("tasks.row.open", { title: task.title })}
        testID={`task-row-${task.id}`}
      />
      <View style={styles.main} pointerEvents="box-none">
        <View style={styles.leading} pointerEvents="box-none">
          <TaskStatusMark
            status={task.status}
            label={t(isDone ? "tasks.row.markNotDone" : "tasks.row.markDone", {
              title: task.title,
            })}
            onToggle={onToggleDone}
            testID={`task-mark-${task.id}`}
          />
        </View>
        <View style={styles.textGroup} pointerEvents="box-none">
          <Text
            style={[settingsStyles.rowTitle, isDone && styles.doneTitle]}
            numberOfLines={1}
            pointerEvents="none"
          >
            {task.title}
          </Text>
          <TaskDescription task={task} lines={1} />
          <View style={styles.meta} pointerEvents="box-none">
            {showHost ? (
              <Text style={styles.metaText} numberOfLines={1} pointerEvents="none">
                {task.serverName}
              </Text>
            ) : null}
            {chats.map((chat) => (
              <TaskChatChip
                key={`${chat.serverId}:${chat.agentId}`}
                chat={chat}
                testID={`task-chat-${task.id}-${chat.agentId}`}
              />
            ))}
            <TaskLabelChips task={task} />
          </View>
        </View>
      </View>
      <View style={styles.trailing} pointerEvents="box-none">
        <TaskKebabMenu task={task} actions={actions} />
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  row: {
    gap: theme.spacing[3],
    position: "relative",
  },
  rowHovered: { backgroundColor: theme.colors.surface2 },
  rowPressed: { backgroundColor: theme.colors.surface3 },
  pressLayer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  main: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
  },
  leading: {
    width: 18,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  textGroup: { flex: 1, minWidth: 0 },
  doneTitle: {
    color: theme.colors.foregroundMuted,
    textDecorationLine: "line-through",
  },
  description: {
    marginTop: theme.spacing[1],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  pending: {
    marginTop: theme.spacing[1],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  spinner: { color: theme.colors.foregroundMuted },
  meta: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: theme.spacing[3],
    rowGap: theme.spacing[1],
    marginTop: theme.spacing[1],
  },
  metaText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));
