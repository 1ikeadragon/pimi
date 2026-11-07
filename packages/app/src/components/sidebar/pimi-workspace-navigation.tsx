// Pimi addition to the Paseo fork. Apache-2.0.
import { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Columns3, FileDiff, ListTodo, MessageSquare, NotebookText } from "lucide-react-native";
import { getDesktopHost } from "@/desktop/host";
import { usePimiWorkspaceSection } from "@/desktop/pimi-console-content";
import { PaseoLogo } from "@/components/icons/paseo-logo";
import { SidebarHeaderRow } from "./sidebar-header-row";

export function PimiWorkspaceNavigation() {
  const host = getDesktopHost();
  const show = host?.showPimiWorkspace;
  const section = usePimiWorkspaceSection();
  const showChat = useCallback(() => host?.dismissPimiWorkspace?.(), [host]);
  const showTasks = useCallback(() => show?.({ view: "tasks" }), [show]);
  const showWorktrees = useCallback(() => show?.({ view: "worktrees" }), [show]);
  const showReview = useCallback(() => show?.({ view: "review-home" }), [show]);
  const showMemory = useCallback(() => show?.({ view: "memory" }), [show]);
  if (!show) return null;

  return (
    <View>
      <View style={styles.brand}>
        <View style={styles.mark}>
          <BrandMark />
        </View>
        <View>
          <Text style={styles.name}>Pimi</Text>
          <Text style={styles.caption}>Your swarm’s best friend</Text>
        </View>
      </View>
      <SidebarHeaderRow
        icon={MessageSquare}
        label="Chat"
        onPress={showChat}
        variant="compact"
        isActive={!section}
      />
      <SidebarHeaderRow
        icon={ListTodo}
        label="Tasks"
        onPress={showTasks}
        variant="compact"
        isActive={section === "tasks"}
      />
      <SidebarHeaderRow
        icon={Columns3}
        label="Work"
        onPress={showWorktrees}
        variant="compact"
        isActive={section === "board"}
      />
      <SidebarHeaderRow
        icon={FileDiff}
        label="Review"
        onPress={showReview}
        variant="compact"
        isActive={section === "review"}
      />
      <SidebarHeaderRow
        icon={NotebookText}
        label="Memory"
        onPress={showMemory}
        variant="compact"
        isActive={section === "memory"}
      />
      <Text style={styles.section}>Agent tools</Text>
    </View>
  );
}

const BrandMark = withUnistyles(PaseoLogo, (theme) => ({
  size: 19,
  color: theme.colors.accentForeground,
}));

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
