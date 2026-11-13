import { Fragment, useMemo, type ReactNode } from "react";
import { useTranslation } from "@/i18n/use-translation";
import { CompactHeader } from "@/components/headers/compact-header";
import {
  EXPLORER_TOGGLE_KEYS,
  WorkspaceExplorerToggle,
} from "@/screens/workspace/workspace-explorer-toggle";
import { WorkspaceHeaderProjectRow } from "@/screens/workspace/workspace-header-project-row";
import {
  useWindowLayout,
  resolveWorkspaceActionPlacement,
  resolveWorkspaceBarActions,
  WindowLayoutActions,
} from "@/window-layout";
import { SidebarCloseButton } from "@/components/headers/sidebar-close-button";
import { IconButtonChromeProvider } from "@/components/ui/icon-button-chrome";

export { MobileWorkspaceTabSwitcher } from "./tab-switcher";

interface CompactWorkspaceHeaderProps {
  desktopPane?: boolean;
  serverId: string;
  workspaceId: string;
  isLoading: boolean;
  title: string;
  subtitle: string;
  isSubtitleDistinct: boolean;
  currentBranchName: string | null;
  onToggleExplorer: () => void;
  explorerToggleLabel: string;
  explorerToggleAccessibilityState: { expanded: boolean };
  tabSwitcher: ReactNode;
  /** Workspace overflow menu. */
  children: ReactNode;
  headerVariant: "compact" | "full";
  actionsActive: boolean;
  /** Attack mode's holding pane: an X that hides the pane without closing its tabs. */
  onHidePane?: () => void;
  /** Closes the pane's active tab where the narrow pane has no tab row. */
  onClosePane?: () => void;
}

/** The compact header with the workspace's project row and controls. */
export function CompactWorkspaceHeader({
  desktopPane,
  isLoading,
  title,
  subtitle,
  isSubtitleDistinct,
  currentBranchName,
  onToggleExplorer,
  explorerToggleLabel,
  explorerToggleAccessibilityState,
  children,
  tabSwitcher,
  serverId,
  workspaceId,
  headerVariant,
  actionsActive,
  onHidePane,
  onClosePane,
}: CompactWorkspaceHeaderProps) {
  const { t } = useTranslation();
  const actionsInBar = resolveWorkspaceActionPlacement(useWindowLayout()) === "vertical-bar";
  const projectRow = useMemo(
    () => (
      <WorkspaceHeaderProjectRow
        subtitle={subtitle}
        isSubtitleDistinct={isSubtitleDistinct}
        branch={currentBranchName}
        serverId={serverId}
        workspaceId={workspaceId}
      />
    ),
    [subtitle, isSubtitleDistinct, currentBranchName, serverId, workspaceId],
  );
  const symbols = {
    "tab-count": tabSwitcher,
    overflow: children,
    explorer: (
      <WorkspaceExplorerToggle
        onPress={onToggleExplorer}
        label={explorerToggleLabel}
        tooltipLabel={t("workspace.tabs.explorerSidebar.toggle")}
        tooltipKeys={EXPLORER_TOGGLE_KEYS}
        accessibilityState={explorerToggleAccessibilityState}
        mobile
      />
    ),
  };
  const actions = resolveWorkspaceBarActions(headerVariant).map((symbol) => (
    <Fragment key={symbol}>{symbols[symbol]}</Fragment>
  ));
  if (onHidePane && headerVariant === "compact") {
    actions.push(
      <SidebarCloseButton
        key="hide-pane"
        label={t("workspace.tabs.actions.hidePane")}
        onPress={onHidePane}
        testID="workspace-hide-pane"
      />,
    );
  }

  if (onClosePane && !onHidePane && headerVariant === "compact") {
    actions.push(
      <SidebarCloseButton
        key="close-pane"
        label={t("workspace.tabs.menu.close")}
        onPress={onClosePane}
        testID="workspace-close-pane"
      />,
    );
  }

  return (
    <IconButtonChromeProvider value="header-island">
      {headerVariant === "compact" ? (
        <CompactHeader
          desktopPane={desktopPane}
          navigation="menu"
          title={title}
          titleTestID="workspace-header-title"
          subtitle={desktopPane ? undefined : projectRow}
          loading={isLoading}
          actions={actionsInBar ? undefined : actions}
        />
      ) : null}
      <WindowLayoutActions active={actionsActive}>{actions}</WindowLayoutActions>
    </IconButtonChromeProvider>
  );
}
