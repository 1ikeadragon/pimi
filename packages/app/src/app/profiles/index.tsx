import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { ProfilesScreen } from "@/screens/profiles/profiles-screen";

export default function ProfilesRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <ProfilesScreen />
    </HostRouteBootstrapBoundary>
  );
}
