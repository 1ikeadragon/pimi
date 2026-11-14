import { memo, useCallback, useRef, useState, type ReactElement } from "react";
import { Text, View, type GestureResponderEvent, type ViewStyle } from "react-native";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StyleSheet } from "react-native-unistyles";
import type { TaskStatus } from "@pimi/protocol/task/types";
import { TaskChatChip } from "@/components/tasks/task-chat-chip";
import { TaskPullRequests } from "@/components/tasks/task-pull-requests";
import { resolveTaskChats } from "@/components/tasks/task-item";
import { TaskKebabMenu } from "@/components/tasks/task-menu";
import { TaskStatusMark } from "@/components/tasks/task-status-mark";
import { isWeb } from "@/constants/platform";
import { useReducedMotion } from "react-native-reanimated";
import { TaskDescription } from "@/components/tasks/task-description";
import { TaskLabelChips } from "@/components/tasks/task-label-chips";
import { useTranslation } from "@/i18n/use-translation";
import type { AggregatedTask } from "@/tasks/aggregated-tasks";
import type { TaskChatDirectory } from "@/tasks/use-chat-directory";
import { useTaskItem } from "@/tasks/use-task-item";

/** A pointer must travel this far before a press becomes a drag. */
const DRAG_THRESHOLD_PX = 5;
const WEB_GRAB: ViewStyle | null = isWeb
  ? ({ cursor: "grab", userSelect: "none" } as unknown as ViewStyle)
  : null;
const WEB_GRABBING: ViewStyle | null = isWeb
  ? ({ cursor: "grabbing" } as unknown as ViewStyle)
  : null;
export const TASK_COLUMN_ATTRIBUTE = "taskColumn";

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  dx: number;
  dy: number;
  active: boolean;
}

/** The status of the board column under a viewport point, read from the column's data attribute. */
function columnAtPoint(x: number, y: number): TaskStatus | null {
  if (typeof document === "undefined") return null;
  for (const element of document.elementsFromPoint(x, y)) {
    const status = (element as HTMLElement).dataset?.[TASK_COLUMN_ATTRIBUTE];
    if (status === "todo" || status === "in_progress" || status === "done") return status;
  }
  return null;
}

interface PointerLikeEvent {
  nativeEvent: PointerEvent;
}

/**
 * A card on the board. On web it can be dragged to another column; everywhere the kebab's status
 * items move it, so touch and keyboard users lose nothing. The drag is a pointer-capture gesture:
 * the card follows the pointer, the column under it lights up, release over a column moves it.
 */
export const TaskBoardCard = memo(function TaskBoardCard({
  task,
  directory,
  showHost,
  onDragOver,
  onDragActive,
}: {
  task: AggregatedTask;
  directory: TaskChatDirectory;
  showHost: boolean;
  onDragOver: (status: TaskStatus | null) => void;
  /** The origin column while a drag is in flight, so it can paint above its siblings. */
  onDragActive: (status: TaskStatus | null) => void;
}): ReactElement {
  const { t } = useTranslation();
  const item = useTaskItem(task);
  const chats = resolveTaskChats(task, directory);
  const reducedMotion = useReducedMotion();
  const drag = useRef<DragState | null>(null);
  const suppressPress = useRef(false);
  const [offset, setOffset] = useState<{ dx: number; dy: number } | null>(null);
  const isDone = task.status === "done";

  const onPointerDown = useCallback((event: PointerLikeEvent) => {
    const native = event.nativeEvent;
    if (native.button !== 0 || native.pointerType === "touch") return;
    drag.current = {
      pointerId: native.pointerId,
      startX: native.clientX,
      startY: native.clientY,
      dx: 0,
      dy: 0,
      active: false,
    };
  }, []);

  const onPointerMove = useCallback(
    (event: PointerLikeEvent) => {
      const state = drag.current;
      const native = event.nativeEvent;
      if (!state || state.pointerId !== native.pointerId) return;
      const dx = native.clientX - state.startX;
      const dy = native.clientY - state.startY;
      if (!state.active) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        state.active = true;
        onDragActive(task.status);
        (native.target as Element | null)?.setPointerCapture?.(native.pointerId);
      }
      state.dx = dx;
      state.dy = dy;
      setOffset({ dx, dy });
      onDragOver(columnAtPoint(native.clientX, native.clientY));
    },
    [onDragActive, onDragOver, task.status],
  );

  const finishDrag = useCallback(
    (event: PointerLikeEvent, cancelled: boolean) => {
      const state = drag.current;
      const native = event.nativeEvent;
      if (!state || state.pointerId !== native.pointerId) return;
      drag.current = null;
      if (!state.active) return;
      (native.target as Element | null)?.releasePointerCapture?.(native.pointerId);
      suppressPress.current = true;
      setTimeout(() => {
        suppressPress.current = false;
      }, 0);
      setOffset(null);
      onDragOver(null);
      onDragActive(null);
      if (cancelled) return;
      const target = columnAtPoint(native.clientX, native.clientY);
      if (target && target !== task.status) {
        item.actions.onSetStatus(target);
      }
    },
    [item.actions, onDragActive, onDragOver, task.status],
  );

  const onPointerUp = useCallback(
    (event: PointerLikeEvent) => finishDrag(event, false),
    [finishDrag],
  );
  const onPointerCancel = useCallback(
    (event: PointerLikeEvent) => finishDrag(event, true),
    [finishDrag],
  );

  const open = useCallback(
    (_event: GestureResponderEvent) => {
      if (suppressPress.current) return;
      item.onOpen();
    },
    [item],
  );

  const webHandlers = isWeb
    ? ({ onPointerDown, onPointerMove, onPointerUp, onPointerCancel } as object)
    : null;
  const dragging = offset !== null;
  const dragStyle: ViewStyle | null = dragging
    ? {
        transform: [{ translateX: offset.dx }, { translateY: offset.dy }],
        zIndex: 10,
        opacity: reducedMotion ? 1 : 0.92,
      }
    : null;

  return (
    <View
      {...webHandlers}
      style={[
        styles.card,
        WEB_GRAB,
        dragging && styles.cardDragging,
        dragging && WEB_GRABBING,
        dragStyle,
      ]}
      testID={`task-card-${task.id}`}
    >
      <PressHighlight
        style={styles.pressLayer}
        onPress={open}
        accessibilityRole="button"
        accessibilityLabel={t("tasks.row.open", { title: task.title })}
        testID={`task-card-open-${task.id}`}
      />
      <View style={styles.head} pointerEvents="box-none">
        <View style={styles.mark} pointerEvents="box-none">
          <TaskStatusMark
            status={task.status}
            label={t(isDone ? "tasks.row.markNotDone" : "tasks.row.markDone", {
              title: task.title,
            })}
            onToggle={item.onToggleDone}
          />
        </View>
        <Text
          style={[styles.title, isDone && styles.doneTitle]}
          numberOfLines={2}
          pointerEvents="none"
        >
          {task.title}
        </Text>
        <TaskKebabMenu task={task} actions={item.actions} testIDPrefix="task-card" />
      </View>
      <TaskDescription task={task} lines={2} />
      <View style={styles.meta} pointerEvents="box-none">
        {showHost ? (
          <Text style={styles.metaText} numberOfLines={1} pointerEvents="none">
            {task.serverName}
          </Text>
        ) : null}
        <TaskPullRequests task={task} />
        {chats.map((chat) => (
          <TaskChatChip key={`${chat.serverId}:${chat.agentId}`} chat={chat} />
        ))}
        <TaskLabelChips task={task} />
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  card: {
    position: "relative",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
  },
  cardDragging: {
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface2,
  },
  pressLayer: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  head: { flexDirection: "row", alignItems: "flex-start", gap: theme.spacing[3] },
  mark: { width: 18, height: 20, alignItems: "center", justifyContent: "center" },
  title: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  doneTitle: { color: theme.colors.foregroundMuted, textDecorationLine: "line-through" },
  description: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  pending: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  spinner: { color: theme.colors.foregroundMuted },
  meta: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: theme.spacing[3],
    rowGap: theme.spacing[1],
  },
  metaText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
