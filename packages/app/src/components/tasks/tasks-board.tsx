import { useCallback, useState, type ReactElement } from "react";
import { ScrollView, Text, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { TaskStatus } from "@pimi/protocol/task/types";
import { TaskBoardCard, TASK_COLUMN_ATTRIBUTE } from "@/components/tasks/task-board-card";
import { TaskStatusGlyph } from "@/components/tasks/task-status-mark";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useTranslation } from "@/i18n/use-translation";
import type { TaskGroup } from "@/tasks/task-view-model";
import type { TaskChatDirectory } from "@/tasks/use-chat-directory";

const COLUMN_MIN_WIDTH = 240;
const COLUMN_MAX_WIDTH = 360;
const COLUMN_GAP = 12;
const EDGE_WIDTH = 12;
const COMPACT_COLUMN_WIDTH = 288;

/**
 * To do / In progress / Done as three columns. Wide screens share the width; compact screens
 * scroll sideways with one column snapped at a time, so a 420px window stays usable.
 */
export function TasksBoard({
  columns,
  directory,
  showHost,
}: {
  columns: readonly TaskGroup[];
  directory: TaskChatDirectory;
  showHost: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [overStatus, setOverStatus] = useState<TaskStatus | null>(null);
  const [activeStatus, setActiveStatus] = useState<TaskStatus | null>(null);
  const handleDragOver = useCallback((status: TaskStatus | null) => setOverStatus(status), []);
  const [viewportWidth, setViewportWidth] = useState(0);
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => setViewportWidth(event.nativeEvent.layout.width),
    [],
  );
  // Columns share the viewport equally between the min and max. The scroller sizes its content to
  // max-content, so a flexible column would stretch to its widest card instead of the viewport.
  const columnWidth = isCompact
    ? COMPACT_COLUMN_WIDTH
    : Math.min(
        COLUMN_MAX_WIDTH,
        Math.max(
          COLUMN_MIN_WIDTH,
          Math.floor(
            (viewportWidth - 2 * EDGE_WIDTH - (columns.length + 1) * COLUMN_GAP) / columns.length,
          ),
        ),
      );
  const handleDragActive = useCallback((status: TaskStatus | null) => setActiveStatus(status), []);

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.scroller}
      contentContainerStyle={styles.columns}
      snapToInterval={isCompact ? COMPACT_COLUMN_WIDTH + 12 : undefined}
      decelerationRate="fast"
      onLayout={handleLayout}
      testID="tasks-board"
    >
      <View style={styles.edgeStart} />
      {columns.map((column) => {
        const status = column.status as TaskStatus;
        const columnData = { [TASK_COLUMN_ATTRIBUTE]: status };
        return (
          <View
            key={column.id}
            // Read by the card's drag gesture to resolve the drop target under the pointer.
            {...({ dataSet: columnData } as object)}
            style={[
              styles.column,
              { width: columnWidth },
              overStatus === status && styles.columnOver,
              // RN-web gives every View its own stacking context; the dragged card can only paint
              // over the other columns if its own column does.
              activeStatus === status && styles.columnActive,
            ]}
            accessibilityLabel={t("tasks.board.accessibility", {
              status: t(`tasks.status.${status}`),
            })}
            testID={`task-column-${status}`}
          >
            <View style={styles.heading} pointerEvents="none">
              <TaskStatusGlyph status={status} />
              <Text style={styles.headingTitle}>{t(`tasks.status.${status}`)}</Text>
              <Text style={styles.headingCount}>{column.tasks.length}</Text>
            </View>
            <View style={styles.cards}>
              {column.tasks.length === 0 ? (
                <Text style={styles.empty} pointerEvents="none">
                  {overStatus === status ? t("tasks.board.dropHere") : t("tasks.empty.board")}
                </Text>
              ) : (
                column.tasks.map((task) => (
                  <TaskBoardCard
                    key={`${task.serverId}:${task.id}`}
                    task={task}
                    directory={directory}
                    showHost={showHost}
                    onDragOver={handleDragOver}
                    onDragActive={handleDragActive}
                  />
                ))
              )}
            </View>
          </View>
        );
      })}
      <View style={styles.edgeEnd} />
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  scroller: { flexGrow: 0 },
  columns: {
    minWidth: "100%",
    gap: theme.spacing[3],
    alignItems: "stretch",
  },
  column: {
    minHeight: 320,
    gap: theme.spacing[3],
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: "transparent",
  },
  columnOver: {
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.borderAccent,
  },
  // The screen gutter, as spacers: padding on a `minWidth: 100%` row pushes it past the viewport.
  // The row's own gap already contributes theme.spacing[3] beside each spacer.
  edgeStart: { width: { xs: 0, md: theme.spacing[3] } },
  edgeEnd: { width: { xs: 0, md: theme.spacing[3] } },
  columnActive: { zIndex: 5 },
  heading: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginLeft: theme.spacing[1],
  },
  headingTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  headingCount: { color: theme.colors.foregroundExtraMuted, fontSize: theme.fontSize.sm },
  cards: { gap: theme.spacing[3], minHeight: 64 },
  empty: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
    paddingVertical: theme.spacing[6],
  },
}));
