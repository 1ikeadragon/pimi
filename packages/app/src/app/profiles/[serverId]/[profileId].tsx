import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { ProfileEditorScreen } from "@/screens/profiles/profile-editor-screen";

export default function ProfileEditorRoute() {
  const params = useLocalSearchParams<{ serverId?: string; profileId?: string }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";
  const profileId = typeof params.profileId === "string" ? params.profileId : "";
  return (
    <HostRouteBootstrapBoundary>
      <ProfileEditorScreen
        key={`${serverId}:${profileId}`}
        serverId={serverId}
        profileId={profileId}
      />
    </HostRouteBootstrapBoundary>
  );
}
