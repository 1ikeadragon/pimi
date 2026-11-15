import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { FlowEditorScreen } from "@/flows/flow-editor-screen";

// `flowId` "new" opens an empty editor.
export default function FlowEditorRoute() {
  const params = useLocalSearchParams<{ serverId?: string; flowId?: string }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";
  const flowId = typeof params.flowId === "string" ? params.flowId : "";
  return (
    <HostRouteBootstrapBoundary>
      <FlowEditorScreen key={`${serverId}:${flowId}`} serverId={serverId} flowId={flowId} />
    </HostRouteBootstrapBoundary>
  );
}
