// Pimi Android navigation for remote-capable app views. Apache-2.0.
import { usePathname } from "expo-router";
import { BriefcaseBusiness, LayoutGrid, ListTodo } from "lucide-react-native";
import { UsageIcon } from "@/usage/icon";
import { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { openPimiAgentGrid, PIMI_AGENT_GRID_ROUTE } from "@/navigation/pimi-agent-grid";
import { openPimiTasks, PIMI_TASKS_ROUTE } from "@/navigation/pimi-tasks";
import { openPimiUsage, PIMI_USAGE_ROUTE } from "@/navigation/pimi-usage";
import { openPimiWork, PIMI_WORK_ROUTE } from "@/navigation/pimi-work";
import { isPimiAndroid } from "@/utils/pimi-mobile";

export function PimiMobileNavigation({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const openTasks = useCallback(() => {
    onNavigate?.();
    openPimiTasks();
  }, [onNavigate]);
  const openAgentGrid = useCallback(() => {
    onNavigate?.();
    openPimiAgentGrid();
  }, [onNavigate]);
  const openUsage = useCallback(() => {
    onNavigate?.();
    openPimiUsage();
  }, [onNavigate]);
  const openWork = useCallback(() => {
    onNavigate?.();
    openPimiWork();
  }, [onNavigate]);

  if (!isPimiAndroid()) return null;

  return (
    <View style={styles.container} testID="pimi-mobile-navigation">
      <Text style={styles.heading}>Pimi</Text>
      <SidebarHeaderRow
        icon={BriefcaseBusiness}
        label="Work"
        onPress={openWork}
        isActive={pathname === PIMI_WORK_ROUTE}
        testID="pimi-work"
        variant="compact"
      />
      <SidebarHeaderRow
        icon={ListTodo}
        label="Tasks"
        onPress={openTasks}
        isActive={pathname === PIMI_TASKS_ROUTE}
        testID="pimi-tasks"
        variant="compact"
      />
      <SidebarHeaderRow
        icon={LayoutGrid}
        label="Agent grid"
        onPress={openAgentGrid}
        isActive={pathname === PIMI_AGENT_GRID_ROUTE}
        testID="pimi-mobile-agent-grid"
        variant="compact"
      />
      <SidebarHeaderRow
        icon={UsageIcon}
        label="Usage"
        onPress={openUsage}
        isActive={pathname === PIMI_USAGE_ROUTE}
        testID="pimi-mobile-usage"
        variant="compact"
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  heading: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[1],
  },
}));
