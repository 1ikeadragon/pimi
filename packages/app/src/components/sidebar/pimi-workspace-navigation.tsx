// Pimi addition to the Paseo fork. Apache-2.0.
import { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Columns3, ListTodo } from "lucide-react-native";
import { getDesktopHost } from "@/desktop/host";
import { SidebarHeaderRow } from "./sidebar-header-row";

export function PimiWorkspaceNavigation() {
  const show = getDesktopHost()?.showPimiWorkspace;
  const showTasks = useCallback(() => show?.({ view: "tasks" }), [show]);
  const showWorktrees = useCallback(() => show?.({ view: "worktrees" }), [show]);
  if (!show) return null;

  return (
    <View>
      <View style={styles.brand}>
        <View style={styles.mark}>
          <Text style={styles.initial}>P</Text>
        </View>
        <View>
          <Text style={styles.name}>Pimi</Text>
          <Text style={styles.caption}>Project workspace</Text>
        </View>
      </View>
      <SidebarHeaderRow icon={ListTodo} label="Tasks" onPress={showTasks} variant="compact" />
      <SidebarHeaderRow
        icon={Columns3}
        label="Worktrees"
        onPress={showWorktrees}
        variant="compact"
      />
      <Text style={styles.section}>Agent tools</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  brand: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 15,
    paddingTop: 13,
    paddingBottom: 9,
  },
  mark: {
    width: 31,
    height: 31,
    borderRadius: 9,
    backgroundColor: theme.colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  initial: { color: theme.colors.accentForeground, fontSize: 18, fontWeight: "700" },
  name: { color: theme.colors.foreground, fontSize: 16, fontWeight: theme.fontWeight.semibold },
  caption: { color: theme.colors.foregroundMuted, fontSize: 11 },
  section: {
    color: theme.colors.foregroundMuted,
    fontSize: 11,
    fontWeight: "600",
    paddingHorizontal: 15,
    paddingTop: 12,
    paddingBottom: 3,
  },
}));
