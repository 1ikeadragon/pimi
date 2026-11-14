import type { ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Circle } from "lucide-react-native";
import { identityForeground } from "@/styles/identity-colors";
import { TaskStatusGlyph } from "@/components/tasks/task-status-mark";
import { useTranslation } from "@/i18n/use-translation";
import { LABEL_COLORS, type Label } from "@pimi/protocol/labels";
import type { Theme } from "@/styles/theme";
import type { TaskGroup } from "@/tasks/task-view-model";

/** Structural heading above a group's card: status glyph or label name, and a count. */
const ThemedCircle = withUnistyles(Circle);

// One stable mapping per color for the life of the module: `withUnistyles` re-subscribes whenever
// `uniProps` changes identity, so a mapping built in render would re-subscribe every frame.
const COLOR_DOT_MAPPINGS = Object.fromEntries(
  LABEL_COLORS.map((color) => [
    color,
    (theme: Theme) => {
      const ink = identityForeground(color, theme.colorScheme);
      return { color: ink, fill: ink };
    },
  ]),
) as Record<Label["color"], (theme: Theme) => { color: string; fill: string }>;

export function LabelColorDot({ color }: { color: Label["color"] }): ReactElement {
  return <ThemedCircle size={10} uniProps={COLOR_DOT_MAPPINGS[color]} />;
}

export function TaskGroupHeading({ group }: { group: TaskGroup }): ReactElement | null {
  const { t } = useTranslation();
  if (group.id === "all") return null;
  let title: string;
  if (group.status) title = t(`tasks.status.${group.status}`);
  else if (group.label) title = group.label.name;
  else title = t("tasks.unlabelled");
  return (
    <View style={styles.heading} testID={`task-group-${group.id || "unlabelled"}`}>
      {group.status ? <TaskStatusGlyph status={group.status} /> : null}
      {group.label ? <LabelColorDot color={group.label.color} /> : null}
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      <Text style={styles.count}>{group.tasks.length}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  heading: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[3],
    marginLeft: theme.spacing[1],
  },
  title: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  count: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
}));
