// Pimi addition to the Paseo fork. Apache-2.0.
import { useCallback, type ReactNode } from "react";
import { router } from "expo-router";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  Columns3,
  FileDiff,
  ListTodo,
  MessageSquare,
  NotebookText,
  PanelLeftOpen,
  Pin,
  Settings,
  StickyNote,
  SquarePen,
  X,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { getDesktopHost, usesPimiMacTitlebar } from "@/desktop/host";
import { usePimiWorkspaceSection } from "@/desktop/pimi-console-content";
import { PaseoLogo } from "@/components/icons/paseo-logo";
import { DensityIcon } from "@/components/ui/density-icon";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { HEADER_INNER_HEIGHT } from "@/constants/layout";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";
import { SidebarHeaderRow, type SidebarRowIcon } from "./sidebar-header-row";

export interface PimiSidebarControls {
  mode: "dock" | "rail" | "peek";
  openPeek: () => void;
  closePeek: () => void;
  pin: () => void;
}

const NO_SHORTCUT: [] = [];
const SELECTED = { selected: true } as const;
export const PIMI_NAV_RAIL_WIDTH = 52;

function SidebarIcon({
  icon,
  label,
  onPress,
  active = false,
  testID,
}: {
  icon: SidebarRowIcon;
  label: string;
  onPress: () => void;
  active?: boolean;
  testID?: string;
}) {
  return (
    <HeaderToggleButton
      onPress={onPress}
      tooltipLabel={label}
      tooltipKeys={NO_SHORTCUT}
      tooltipSide="right"
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={active ? SELECTED : undefined}
      style={[styles.railButton, active && styles.railButtonSelected]}
      testID={testID}
    >
      <DensityIcon icon={icon} size="sm" color={active ? "foreground" : "foregroundMuted"} />
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
  return (
    <View style={styles.rail} testID="pimi-sidebar-rail">
      <View style={[styles.railChrome, usesPimiMacTitlebar() && styles.pimiMacChrome]}>
        <TitlebarDragRegion />
      </View>
      <View style={styles.railCard}>
        <SidebarIcon
          icon={PanelLeftOpen}
          label={t("sidebar.actions.peekSidebar")}
          onPress={controls.openPeek}
          testID="pimi-sidebar-peek"
        />
        <PimiWorkspaceNavigation rail />
        <View style={styles.railSpacer} />
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

export function PimiWorkspaceNavigation({
  rail = false,
  onNavigate,
  trailing,
}: {
  rail?: boolean;
  onNavigate?: () => void;
  trailing?: ReactNode;
} = {}) {
  const host = getDesktopHost();
  const show = host?.showPimiWorkspace;
  const section = usePimiWorkspaceSection();
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
  }, [host, onNavigate]);
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
  if (!show) return null;

  const destinations = [
    { label: "Chat", icon: MessageSquare, onPress: showChat, active: !section },
    { label: "Tasks", icon: ListTodo, onPress: showTasks, active: section === "tasks" },
    { label: "Work", icon: Columns3, onPress: showWorktrees, active: section === "board" },
    { label: "Review", icon: FileDiff, onPress: showReview, active: section === "review" },
    { label: "Memory", icon: NotebookText, onPress: showMemory, active: section === "memory" },
    { label: "Spaces", icon: StickyNote, onPress: showSpaces, active: section === "spaces" },
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
        {destinations.map((item) => (
          <SidebarIcon key={item.label} {...item} />
        ))}
      </View>
    );
  }
  return (
    <View>
      <View style={styles.brand}>
        <View style={styles.mark}>
          <BrandMark />
        </View>
        <View style={styles.brandLabel}>
          <Text style={styles.name}>Pimi</Text>
          <Text style={styles.caption} numberOfLines={1}>
            Your swarm’s best friend
          </Text>
        </View>
        {trailing}
      </View>
      {destinations.map(({ label, icon, onPress, active }) => (
        <SidebarHeaderRow
          key={label}
          label={label}
          icon={icon}
          onPress={onPress}
          variant="compact"
          isActive={active}
        />
      ))}
      <Text style={styles.section}>Agent tools</Text>
    </View>
  );
}

const BrandMark = withUnistyles(PaseoLogo, (theme) => ({
  size: 19,
  color: theme.colors.accentForeground,
}));

const styles = StyleSheet.create((theme) => ({
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
  railSpacer: { flex: 1 },
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
