import { Circle, CircleCheck, CircleDot } from "lucide-react-native";
import { memo, useCallback, useMemo, type ReactElement } from "react";
import { View, type PressableStateCallbackType } from "react-native";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { TaskStatus } from "@pimi/protocol/task/types";
import { isNative } from "@/constants/platform";
import type { Theme } from "@/styles/theme";

const ThemedCircle = withUnistyles(Circle);
const ThemedCircleDot = withUnistyles(CircleDot);
const ThemedCircleCheck = withUnistyles(CircleCheck);

const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const runningMapping = (theme: Theme) => ({ color: theme.colors.statusDotRunning });
const doneMapping = (theme: Theme) => ({ color: theme.colors.palette.green[500] });

const MARK_SIZE = 18;

export function TaskStatusGlyph({ status }: { status: TaskStatus }): ReactElement {
  if (status === "done") return <ThemedCircleCheck size={MARK_SIZE} uniProps={doneMapping} />;
  if (status === "in_progress") {
    return <ThemedCircleDot size={MARK_SIZE} uniProps={runningMapping} />;
  }
  return <ThemedCircle size={MARK_SIZE} uniProps={mutedMapping} />;
}

/** The leading mark of a row. Pressing it toggles done, the one action a to-do list lives on. */
export const TaskStatusMark = memo(function TaskStatusMark({
  status,
  label,
  onToggle,
  testID,
}: {
  status: TaskStatus;
  label: string;
  onToggle: () => void;
  testID?: string;
}): ReactElement {
  const style = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.mark,
      hovered && styles.markHovered,
      pressed && styles.markPressed,
    ],
    [],
  );
  const accessibilityState = useMemo(() => ({ checked: status === "done" }), [status]);
  return (
    <PressHighlight
      onPress={onToggle}
      hitSlop={8}
      style={style}
      accessibilityRole={isNative ? "checkbox" : "none"}
      accessibilityState={accessibilityState}
      accessibilityLabel={label}
      testID={testID}
    >
      <View pointerEvents="none">
        <TaskStatusGlyph status={status} />
      </View>
    </PressHighlight>
  );
});

const styles = StyleSheet.create((theme) => ({
  mark: {
    width: MARK_SIZE + theme.spacing[1] * 2,
    height: MARK_SIZE + theme.spacing[1] * 2,
    marginTop: -theme.spacing[1],
    marginLeft: -theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  markHovered: { backgroundColor: theme.colors.surface3 },
  markPressed: { backgroundColor: theme.colors.surface3 },
}));
