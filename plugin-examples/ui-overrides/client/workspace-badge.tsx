import { useTheme, type PluginComponentWrapperProps } from "@pimi/plugin/client";
import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";

/** Wraps each workspace row in the sidebar and adds the branch as a badge after it. */
export function WorkspaceBadge({
  props,
  children,
}: PluginComponentWrapperProps<"sidebar.workspaceRow">) {
  const theme = useTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        badge: { ...base.badge, backgroundColor: theme.colors.surface2 },
        text: { color: theme.colors.foregroundMuted, fontSize: 10 },
      }),
    [theme],
  );
  if (!props.branch) return children;
  return (
    <View style={base.row} testID="ui-overrides-workspace-badge">
      <View style={base.content}>{children}</View>
      <View style={styles.badge}>
        <Text style={styles.text} numberOfLines={1}>
          {props.branch}
        </Text>
      </View>
    </View>
  );
}

const base = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 6 },
  content: { flex: 1 },
  badge: { maxWidth: 80, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
});
