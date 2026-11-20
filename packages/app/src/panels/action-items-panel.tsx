import { useCallback, useEffect, useMemo, useState } from "react";
import { ListChecks, PinOff } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { useActionItemsPreferences } from "@/action-items/preferences";
import { ActionItemsView } from "@/action-items/view";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useTranslation } from "@/i18n/use-translation";
import type { Theme } from "@/styles/theme";
import { openExplorerSidebarView } from "@/workspace-tabs/explorer-sidebar";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel, type PanelPresentation } from "@/panels/panel-registry";
import { useSessionStore } from "@/stores/session-store";
import { invariant } from "@/utils/invariant";

const ThemedListChecks = withUnistyles(ListChecks);
const ThemedPinOff = withUnistyles(PinOff);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const actionItemsPanelPresentation = {
  // The Explorer strip holds three tabs in 240pt; the full name is in the tooltip.
  label: (t) => t("actionItems.tabLabel"),
  subtitle: (t) => t("actionItems.subtitle"),
  tooltip: (t) => t("actionItems.label"),
  icon: ThemedListChecks,
} satisfies PanelPresentation;

function ActionItemsPanel() {
  const { t } = useTranslation();
  const { serverId, workspaceId, target } = usePaneContext();
  const isCompact = useIsCompactFormFactor();
  invariant(target.kind === "action_items", "ActionItemsPanel requires action_items target");
  const active = useRetainedPanelActive();
  const focusedAgentId = useSessionStore(
    (state) => state.sessions[serverId]?.focusedAgentId ?? null,
  );
  // Focus clears while a terminal or file tab is in front; the panel keeps the last chat.
  const [agentId, setAgentId] = useState(focusedAgentId);
  useEffect(() => {
    if (focusedAgentId) setAgentId(focusedAgentId);
  }, [focusedAgentId]);
  // Unpin: back to the floating note, with the Explorer left on Files.
  const handleUnpin = useCallback(() => {
    useActionItemsPreferences.getState().setDocked(false);
    openExplorerSidebarView({
      isCompact: false,
      workspaceKey: buildWorkspaceTabPersistenceKey({ serverId, workspaceId }),
      view: "files",
    });
  }, [serverId, workspaceId]);
  const unpin = useMemo(
    () =>
      isCompact ? undefined : (
        <ToolbarButton
          label={t("actionItems.unpin")}
          onPress={handleUnpin}
          compact
          testID="action-items-unpin"
        >
          <ThemedPinOff size={14} uniProps={mutedMapping} />
        </ToolbarButton>
      ),
    [handleUnpin, isCompact, t],
  );
  return (
    <ActionItemsView serverId={serverId} agentId={agentId} active={active} footerAction={unpin} />
  );
}

export const actionItemsPanelRegistration = definePanel("action_items", {
  component: ActionItemsPanel,
  presentation: actionItemsPanelPresentation,
});
