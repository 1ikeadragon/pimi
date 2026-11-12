import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { AttackPhoneScreen } from "@/attack/attack-phone-screen";
import { decodeWorkspaceIdFromPathSegment } from "@/utils/host-routes";

export default function AttackPhoneRoute() {
  const params = useLocalSearchParams<{ serverId?: string; workspaceId?: string }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";
  const workspaceId =
    typeof params.workspaceId === "string"
      ? (decodeWorkspaceIdFromPathSegment(params.workspaceId) ?? "")
      : "";
  return (
    <HostRouteBootstrapBoundary>
      {serverId && workspaceId ? (
        <AttackPhoneScreen serverId={serverId} workspaceId={workspaceId} />
      ) : null}
    </HostRouteBootstrapBoundary>
  );
}
