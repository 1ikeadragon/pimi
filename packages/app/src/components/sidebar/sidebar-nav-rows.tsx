import { router, usePathname } from "expo-router";
import { Rocket, History, Plus, Search, SquarePen } from "lucide-react-native";
import { memo, useCallback, useMemo, useRef, type ComponentType, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import { DensityIcon } from "@/components/ui/density-icon";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { getDesktopHost } from "@/desktop/host";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { PluginSidebarItem } from "@/plugins/sidebar-items";
import {
  builtinSidebarNavLabelKey,
  builtinSidebarNavShortcutAction,
  type BuiltinSidebarNavId,
} from "@/sidebar-nav/model";
import { useSidebarNavItems } from "@/sidebar-nav/use-sidebar-nav-items";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useWorkspace } from "@/stores/session-store-hooks";
import {
  buildNewWorkspaceRoute,
  buildSchedulesRoute,
  buildSessionsRoute,
} from "@/utils/host-routes";

interface SidebarNavRowProps {
  onBeforeNavigate?: () => void;
  iconOnly?: boolean;
}

interface SidebarNavRowsProps extends SidebarNavRowProps {
  /** Style for the group wrapper, which the sidebar owns. */
  style?: StyleProp<ViewStyle>;
  /** Pimi separates creation/search from destinations; visibility and plugin order stay shared. */
  pimiSection?: "actions" | "destinations" | "create";
  /** Sits to the right of the first row, which shrinks to make room. */
  firstRowTrailing?: ReactNode;
}

/**
 * Top-level sidebar navigation, ordered and filtered by the user's
 * `sidebarNavItems` preference. Renders nothing — not even the bordered group
 * wrapper — when every item is hidden and there is no `firstRowTrailing`.
 */
export function SidebarNavRows({
  style,
  onBeforeNavigate,
  firstRowTrailing,
  pimiSection,
}: SidebarNavRowsProps) {
  const { items } = useSidebarNavItems("header");
  const visibleItems = useMemo(() => items.filter((item) => item.visible), [items]);
  const groupRef = useRef<View | null>(null);

  if (visibleItems.length === 0 && !firstRowTrailing) return null;

  const renderItem = (item: (typeof visibleItems)[number]) => {
    if (item.kind === "plugin") {
      return (
        <PluginSidebarItem
          key={item.key}
          group={item.group}
          section="header"
          fallbackAnchorRef={groupRef}
          onBeforeNavigate={onBeforeNavigate}
        />
      );
    }
    const Row = BUILTIN_ROWS[item.id];
    return <Row key={item.key} onBeforeNavigate={onBeforeNavigate} />;
  };

  if (pimiSection) {
    const newWorkspace = visibleItems.find((item) => item.key === "new-workspace");
    if (pimiSection === "create")
      return newWorkspace ? (
        <SidebarNewWorkspaceRow iconOnly onBeforeNavigate={onBeforeNavigate} />
      ) : null;
    const search = visibleItems.find((item) => item.key === "search");
    const history = visibleItems.find((item) => item.key === "history");
    return (
      <View ref={groupRef} collapsable={false} style={style}>
        {pimiSection === "actions" ? (
          <View style={styles.pimiActions}>
            {search ? <SidebarSearchRow iconOnly /> : null}
            {history ? <SidebarHistoryRow iconOnly onBeforeNavigate={onBeforeNavigate} /> : null}
          </View>
        ) : (
          visibleItems
            .filter((item) => !["new-workspace", "search", "history"].includes(item.key))
            .map(renderItem)
        )}
      </View>
    );
  }

  const [firstRow, ...restRows] = visibleItems.map(renderItem);

  return (
    <View ref={groupRef} collapsable={false} style={style}>
      {firstRowTrailing ? (
        <View style={styles.firstRow}>
          <View style={styles.firstRowItem}>{firstRow}</View>
          {firstRowTrailing}
        </View>
      ) : (
        firstRow
      )}
      {restRows}
    </View>
  );
}

const SidebarNewWorkspaceRow = memo(function SidebarNewWorkspaceRow({
  onBeforeNavigate,
  iconOnly,
}: SidebarNavRowProps) {
  const { t } = useTranslation();
  const pimi = Boolean(getDesktopHost()?.showPimiWorkspace);
  const shortcutKeys = useShortcutKeys(builtinSidebarNavShortcutAction("new-workspace"));
  const activeWorkspaceSelection = useActiveWorkspaceSelection();
  const activeWorkspaceServerId = activeWorkspaceSelection?.serverId ?? null;
  const activeWorkspaceId = activeWorkspaceSelection?.workspaceId ?? null;
  const activeWorkspace = useWorkspace(activeWorkspaceServerId, activeWorkspaceId);

  const handlePress = useCallback(() => {
    onBeforeNavigate?.();
    if (pimi) {
      router.navigate(buildNewWorkspaceRoute({ chooseProject: true }));
      return;
    }
    router.push(
      activeWorkspaceServerId
        ? buildNewWorkspaceRoute(
            activeWorkspace
              ? {
                  serverId: activeWorkspaceServerId,
                  sourceDirectory: activeWorkspace.projectRootPath,
                  projectId: activeWorkspace.projectId,
                }
              : { serverId: activeWorkspaceServerId },
          )
        : buildNewWorkspaceRoute(),
    );
  }, [activeWorkspace, activeWorkspaceServerId, onBeforeNavigate, pimi]);

  if (iconOnly)
    return (
      <HeaderToggleButton
        onPress={handlePress}
        tooltipLabel={t(builtinSidebarNavLabelKey("new-workspace"))}
        tooltipKeys={shortcutKeys?.[0] ?? []}
        tooltipSide="bottom"
        accessibilityRole="button"
        accessibilityLabel={t(builtinSidebarNavLabelKey("new-workspace"))}
        testID="sidebar-global-new-workspace"
      >
        <DensityIcon icon={SquarePen} size="sm" color="foregroundMuted" />
      </HeaderToggleButton>
    );
  return (
    <SidebarHeaderRow
      icon={pimi ? SquarePen : Plus}
      label={t(builtinSidebarNavLabelKey("new-workspace"))}
      onPress={handlePress}
      testID="sidebar-global-new-workspace"
      variant="compact"
      shortcutKeys={shortcutKeys}
    />
  );
});

function SidebarHistoryRow({ onBeforeNavigate, iconOnly }: SidebarNavRowProps) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const handlePress = useCallback(() => {
    onBeforeNavigate?.();
    router.push(buildSessionsRoute());
  }, [onBeforeNavigate]);
  const isActive = pathname.includes("/sessions");
  const accessibilityState = useMemo(() => ({ selected: isActive }), [isActive]);

  if (iconOnly)
    return (
      <HeaderToggleButton
        onPress={handlePress}
        tooltipLabel={t(builtinSidebarNavLabelKey("history"))}
        tooltipKeys={[]}
        tooltipSide="bottom"
        accessibilityRole="button"
        accessibilityLabel={t(builtinSidebarNavLabelKey("history"))}
        testID="sidebar-sessions"
        accessibilityState={accessibilityState}
        style={isActive ? styles.pimiActionSelected : undefined}
      >
        <DensityIcon icon={History} size="sm" color="foregroundMuted" />
      </HeaderToggleButton>
    );
  return (
    <SidebarHeaderRow
      icon={History}
      label={t(builtinSidebarNavLabelKey("history"))}
      onPress={handlePress}
      isActive={isActive}
      testID="sidebar-sessions"
      variant="compact"
    />
  );
}

function SidebarSearchRow({ iconOnly }: SidebarNavRowProps) {
  const { t } = useTranslation();
  const shortcutKeys = useShortcutKeys(builtinSidebarNavShortcutAction("search"));
  const setCommandCenterOpen = useKeyboardShortcutsStore((state) => state.setCommandCenterOpen);
  const handlePress = useCallback(() => {
    setCommandCenterOpen(true);
  }, [setCommandCenterOpen]);

  if (iconOnly)
    return (
      <HeaderToggleButton
        onPress={handlePress}
        tooltipLabel={t(builtinSidebarNavLabelKey("search"))}
        tooltipKeys={shortcutKeys?.[0] ?? []}
        tooltipSide="bottom"
        accessibilityRole="button"
        accessibilityLabel={t(builtinSidebarNavLabelKey("search"))}
        testID="sidebar-search"
      >
        <DensityIcon icon={Search} size="sm" color="foregroundMuted" />
      </HeaderToggleButton>
    );
  return (
    <SidebarHeaderRow
      icon={Search}
      label={t(builtinSidebarNavLabelKey("search"))}
      onPress={handlePress}
      testID="sidebar-search"
      variant="compact"
      shortcutKeys={shortcutKeys}
    />
  );
}

function SidebarSchedulesRow({ onBeforeNavigate }: SidebarNavRowProps) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const handlePress = useCallback(() => {
    onBeforeNavigate?.();
    router.push(buildSchedulesRoute());
  }, [onBeforeNavigate]);

  return (
    <SidebarHeaderRow
      icon={Rocket}
      label={t(builtinSidebarNavLabelKey("schedules"))}
      onPress={handlePress}
      isActive={pathname.includes("/schedules")}
      testID="sidebar-schedules"
      variant="compact"
    />
  );
}

const BUILTIN_ROWS: Record<BuiltinSidebarNavId, ComponentType<SidebarNavRowProps>> = {
  "new-workspace": SidebarNewWorkspaceRow,
  history: SidebarHistoryRow,
  search: SidebarSearchRow,
  schedules: SidebarSchedulesRow,
};

const styles = StyleSheet.create((theme) => ({
  pimiActionSelected: { backgroundColor: theme.colors.surfaceSidebarSelected },
  pimiActions: { flexDirection: "row", alignItems: "center" },
  firstRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  firstRowItem: {
    flex: 1,
    minWidth: 0,
  },
}));
