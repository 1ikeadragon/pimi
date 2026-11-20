import { useEffect, useState } from "react";
import { ListChecks } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { ActionItemsView } from "@/action-items/view";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel, type PanelPresentation } from "@/panels/panel-registry";
import { useSessionStore } from "@/stores/session-store";
import { invariant } from "@/utils/invariant";

const ThemedListChecks = withUnistyles(ListChecks);
const actionItemsPanelPresentation = {
  label: (t) => t("actionItems.label"),
  subtitle: (t) => t("actionItems.subtitle"),
  tooltip: (t) => t("actionItems.label"),
  icon: ThemedListChecks,
} satisfies PanelPresentation;

function ActionItemsPanel() {
  const { serverId, target } = usePaneContext();
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
  return <ActionItemsView serverId={serverId} agentId={agentId} active={active} />;
}

export const actionItemsPanelRegistration = definePanel("action_items", {
  component: ActionItemsPanel,
  presentation: actionItemsPanelPresentation,
});
