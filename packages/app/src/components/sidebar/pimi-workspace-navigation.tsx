// Pimi addition to the Paseo fork. Apache-2.0.
import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import { router, useGlobalSearchParams, usePathname } from "expo-router";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  CircleGauge,
  Columns3,
  FileDiff,
  LayoutGrid,
  ListTodo,
  MessageSquare,
  NotebookText,
  PanelLeftOpen,
  Plug,
  Pin,
  Rocket,
  Settings,
  Sparkles,
  StickyNote,
  SquarePen,
  X,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import type { PimiActivitySection } from "@pimi/protocol/pimi-task";
import { getDesktopHost, usesPimiMacTitlebar } from "@/desktop/host";
import { usePimiWorkspaceSection } from "@/desktop/pimi-console-content";
import { DensityIcon } from "@/components/ui/density-icon";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { HEADER_INNER_HEIGHT } from "@/constants/layout";
import {
  buildNewWorkspaceRoute,
  buildOpenProjectRoute,
  buildSchedulesRoute,
  buildSessionsRoute,
} from "@/utils/host-routes";
import { useSidebarNavItems } from "@/sidebar-nav/use-sidebar-nav-items";
import {
  closePimiAgentGrid,
  openPimiAgentGrid,
  PIMI_AGENT_GRID_ROUTE,
} from "@/navigation/pimi-agent-grid";
import { closePimiUsage, openPimiUsage, PIMI_USAGE_ROUTE } from "@/navigation/pimi-usage";
import { closePimiLibrary, openPimiLibrary, PIMI_LIBRARY_ROUTE } from "@/navigation/pimi-library";
import { SidebarHeaderRow, type SidebarRowIcon } from "./sidebar-header-row";
import { usageHoverDetails } from "@/usage/sidebar-item";

export interface PimiSidebarControls {
  mode: "dock" | "rail" | "peek";
  openPeek: () => void;
  closePeek: () => void;
  pin: () => void;
}

const NO_SHORTCUT: [] = [];
const SELECTED = { selected: true } as const;
export const PIMI_NAV_RAIL_WIDTH = 52;
const useWorkspaceActivity = create<Record<PimiActivitySection, boolean>>(() => ({
  tasks: false,
  board: false,
  review: false,
}));

function SidebarIcon({
  icon,
  label,
  onPress,
  active = false,
  unread = false,
  testID,
  tooltipContent,
}: {
  icon: SidebarRowIcon;
  label: string;
  onPress: () => void;
  active?: boolean;
  unread?: boolean;
  testID?: string;
  tooltipContent?: ReactNode;
}) {
  return (
    <HeaderToggleButton
      onPress={onPress}
      tooltipLabel={label}
      tooltipContent={tooltipContent}
      tooltipKeys={NO_SHORTCUT}
      tooltipSide="right"
      accessibilityRole="button"
      accessibilityLabel={unread ? `${label}, new activity` : label}
      accessibilityState={active ? SELECTED : undefined}
      style={[styles.railButton, active && styles.railButtonSelected]}
      testID={testID}
    >
      <DensityIcon icon={icon} size="sm" color={active ? "foreground" : "foregroundMuted"} />
      {unread ? <View style={[styles.activityDot, styles.railActivityDot]} /> : null}
    </HeaderToggleButton>
  );
}

export function PimiSidebarRail({
  controls,
  onSettings,
}: {
  controls: PimiSidebarControls;
  onSettings: () => void;
}) {
  const { t } = useTranslation();
  const macTitlebar = usesPimiMacTitlebar();
  return (
    <View style={[styles.rail, macTitlebar && styles.pimiMacChrome]} testID="pimi-sidebar-rail">
      <View style={styles.railChrome}>
        <TitlebarDragRegion />
      </View>
      <View style={[styles.railCard, macTitlebar && styles.pimiMacRail]}>
        <SidebarIcon
          icon={PanelLeftOpen}
          label={t("sidebar.actions.peekSidebar")}
          onPress={controls.openPeek}
          testID="pimi-sidebar-peek"
        />
        <ScrollView
          style={styles.railScroll}
          contentContainerStyle={styles.railScrollContent}
          showsVerticalScrollIndicator={false}
        >
          <PimiWorkspaceNavigation rail />
        </ScrollView>
        <SidebarIcon icon={Pin} label={t("sidebar.actions.pinSidebar")} onPress={controls.pin} />
        <SidebarIcon icon={Settings} label={t("sidebar.actions.settings")} onPress={onSettings} />
      </View>
    </View>
  );
}

export function PimiSidebarPeekActions({ controls }: { controls: PimiSidebarControls }) {
  const { t } = useTranslation();
  return (
    <View style={styles.peekActions}>
      <SidebarIcon icon={Pin} label={t("sidebar.actions.pinSidebar")} onPress={controls.pin} />
      <SidebarIcon
        icon={X}
        label={t("sidebar.actions.closeSidebar")}
        onPress={controls.closePeek}
        testID="pimi-sidebar-close-peek"
      />
    </View>
  );
}

function AutomationsRailButton({ active }: { active: boolean }) {
  const { t } = useTranslation();
  const { items } = useSidebarNavItems("header");
  const open = useCallback(() => {
    getDesktopHost()?.dismissPimiWorkspace?.();
    router.navigate(buildSchedulesRoute());
  }, []);
  if (!items.some((item) => item.key === "schedules" && item.visible)) return null;

  return (
    <SidebarIcon
      icon={Rocket}
      label={t("sidebar.sections.schedules")}
      onPress={open}
      active={active}
      testID="pimi-automations-rail"
    />
  );
}

export function PimiWorkspaceNavigation({
  rail = false,
  onNavigate,
  trailing,
  children,
  secondaryNavigation,
}: {
  rail?: boolean;
  onNavigate?: () => void;
  trailing?: ReactNode;
  children?: ReactNode;
  secondaryNavigation?: ReactNode;
} = {}) {
  const host = getDesktopHost();
  const show = host?.showPimiWorkspace;
  const section = usePimiWorkspaceSection();
  const activity = useWorkspaceActivity();
  const unreadFor = (target: PimiActivitySection) => activity[target] && section !== target;
  const activityDot = useMemo(() => <View style={styles.activityDot} />, []);
  useEffect(() => {
    if (section === "tasks" || section === "board" || section === "review") {
      useWorkspaceActivity.setState({ [section]: false });
    }
    return host?.onPimiWorkspaceActivity?.((target) => {
      if (section !== target) useWorkspaceActivity.setState({ [target]: true });
    });
  }, [host, section]);
  const pathname = usePathname();
  const inAgentGrid = pathname === PIMI_AGENT_GRID_ROUTE;
  const inUsage = pathname === PIMI_USAGE_ROUTE;
  const inLibrary = pathname === PIMI_LIBRARY_ROUTE;
  const { section: librarySection } = useGlobalSearchParams<{ section?: string }>();
  const inAutomations = pathname === buildSchedulesRoute();
  const inHistory = pathname === buildSessionsRoute();
  const { t } = useTranslation();
  const newWorkspaceLabel = t("newWorkspace.title");
  const openNewWorkspace = useCallback(() => {
    onNavigate?.();
    host?.dismissPimiWorkspace?.();
    router.navigate(buildNewWorkspaceRoute({ chooseProject: true }));
  }, [host, onNavigate]);
  const showChat = useCallback(() => {
    onNavigate?.();
    host?.dismissPimiWorkspace?.();
    if (inAgentGrid) closePimiAgentGrid();
    else if (inUsage) closePimiUsage();
    else if (inLibrary) closePimiLibrary();
    else if ((inAutomations || inHistory) && !section) {
      if (router.canGoBack()) router.back();
      else router.replace(buildOpenProjectRoute());
    }
  }, [host, inAgentGrid, inAutomations, inHistory, inLibrary, inUsage, onNavigate, section]);
  const showAgentGrid = useCallback(() => {
    onNavigate?.();
    openPimiAgentGrid();
  }, [onNavigate]);
  const showTasks = useCallback(() => {
    onNavigate?.();
    show?.({ view: "tasks" });
  }, [onNavigate, show]);
  const showWorktrees = useCallback(() => {
    onNavigate?.();
    show?.({ view: "worktrees" });
  }, [onNavigate, show]);
  const showReview = useCallback(() => {
    onNavigate?.();
    show?.({ view: "review-home" });
  }, [onNavigate, show]);
  const showMemory = useCallback(() => {
    onNavigate?.();
    show?.({ view: "memory" });
  }, [onNavigate, show]);
  const showSpaces = useCallback(() => {
    onNavigate?.();
    show?.({ view: "spaces" });
  }, [onNavigate, show]);
  const showSkills = useCallback(() => {
    onNavigate?.();
    openPimiLibrary("skills", inLibrary);
  }, [inLibrary, onNavigate]);
  const showHooks = useCallback(() => {
    onNavigate?.();
    openPimiLibrary("hooks", inLibrary);
  }, [inLibrary, onNavigate]);
  if (!show) return null;

  const chatDestination = {
    label: "Chats",
    icon: MessageSquare,
    onPress: showChat,
    active: !section && !inAgentGrid && !inUsage && !inAutomations && !inHistory && !inLibrary,
  };
  const activityDestination = {
    label: "Agents",
    icon: LayoutGrid,
    onPress: showAgentGrid,
    active: !section && inAgentGrid,
  };
  const workDestinations = [
    {
      label: "Tasks",
      icon: ListTodo,
      onPress: showTasks,
      active: section === "tasks",
      unread: unreadFor("tasks"),
    },
    {
      label: "Work",
      icon: Columns3,
      onPress: showWorktrees,
      active: section === "board",
      unread: unreadFor("board"),
    },
    {
      label: "Review",
      icon: FileDiff,
      onPress: showReview,
      active: section === "review",
      unread: unreadFor("review"),
    },
  ];
  const libraryDestinations = [
    {
      label: "Memory",
      icon: NotebookText,
      onPress: showMemory,
      active: section === "memory",
    },
    {
      label: "Spaces",
      icon: StickyNote,
      onPress: showSpaces,
      active: section === "spaces",
    },
    {
      label: "Skills",
      icon: Sparkles,
      onPress: showSkills,
      active: !section && inLibrary && librarySection !== "hooks",
    },
    {
      label: "Hooks",
      icon: Plug,
      onPress: showHooks,
      active: !section && inLibrary && librarySection === "hooks",
    },
  ];
  if (rail) {
    return (
      <View style={styles.railDestinations}>
        <SidebarIcon
          icon={SquarePen}
          label={newWorkspaceLabel}
          onPress={openNewWorkspace}
          testID="pimi-new-workspace-rail"
        />
        {[chatDestination, ...workDestinations, activityDestination, ...libraryDestinations].map(
          (item) => (
            <SidebarIcon key={item.label} {...item} />
          ),
        )}
        <AutomationsRailButton active={!section && inAutomations} />
        <SidebarIcon
          icon={CircleGauge}
          label="Usage"
          onPress={openPimiUsage}
          active={!section && inUsage}
          tooltipContent={usageHoverDetails}
        />
      </View>
    );
  }
  return (
    <View>
      <View style={styles.brand}>
        <View style={styles.brandLabel}>
          <Text style={styles.name}>Pimi</Text>
        </View>
        <SidebarIcon {...chatDestination} label="Back to chats" testID="pimi-back-to-chats" />
        {children}
        {trailing}
      </View>
      {workDestinations.map(({ label, icon, onPress, active, unread }) => (
        <SidebarHeaderRow
          key={label}
          label={label}
          icon={icon}
          onPress={onPress}
          variant="compact"
          isActive={active}
          accessibilityLabel={unread ? `${label}, new activity` : label}
          trailing={unread ? activityDot : undefined}
        />
      ))}
      <Text style={styles.groupLabel}>Activity</Text>
      <SidebarHeaderRow
        label={activityDestination.label}
        icon={activityDestination.icon}
        onPress={activityDestination.onPress}
        isActive={activityDestination.active}
        variant="compact"
      />
      {secondaryNavigation}
      <Text style={styles.groupLabel}>Library</Text>
      {libraryDestinations.map(({ label, icon, onPress, active }) => (
        <SidebarHeaderRow
          key={label}
          label={label}
          icon={icon}
          onPress={onPress}
          variant="compact"
          isActive={active}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  activityDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.foreground,
  },
  railActivityDot: {
    position: "absolute",
    top: 3,
    right: 3,
  },
  rail: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
  },
  railChrome: {
    width: "100%",
    height: HEADER_INNER_HEIGHT,
  },
  pimiMacChrome: {
    backgroundColor: theme.colors.surfaceSidebar,
  },
  railCard: {
    width: 42,
    flex: 1,
    alignItems: "center",
    gap: 4,
    marginBottom: 8,
    borderRadius: 13,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  pimiMacRail: {
    width: "100%",
    marginBottom: 0,
    borderRadius: 0,
    borderWidth: 0,
  },
  railDestinations: {
    gap: 4,
    alignItems: "center",
    paddingTop: 5,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  railButton: {
    borderRadius: 8,
  },
  railButtonSelected: {
    backgroundColor: theme.colors.surfaceSidebarSelected,
  },
  railScroll: { flex: 1, width: "100%" },
  railScrollContent: { alignItems: "center" },
  groupLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },
  peekActions: {
    flexDirection: "row",
    alignItems: "center",
  },
  brand: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 15,
    paddingTop: 13,
    paddingBottom: 9,
  },
  brandLabel: { flex: 1, minWidth: 0 },
  name: {
    color: theme.colors.foreground,
    fontSize: 16,
    fontWeight: theme.fontWeight.semibold,
  },
}));
