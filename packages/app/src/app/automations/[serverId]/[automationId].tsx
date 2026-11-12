import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { AutomationEditorScreen } from "@/screens/automation-editor-screen";

export default function AutomationEditorRoute() {
  const params = useLocalSearchParams<{ serverId?: string; automationId?: string }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";
  const automationId = typeof params.automationId === "string" ? params.automationId : "";
  return (
    <HostRouteBootstrapBoundary>
      <AutomationEditorScreen
        key={`${serverId}:${automationId}`}
        mode="edit"
        serverId={serverId}
        automationId={automationId}
      />
    </HostRouteBootstrapBoundary>
  );
}
