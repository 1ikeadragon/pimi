import { noProps, overridable } from "@/extension-points";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { SessionsScreen } from "@/screens/sessions-screen";

const Sessions = overridable("screen.sessions", SessionsScreen, noProps());

export default function SessionsRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <Sessions />
    </HostRouteBootstrapBoundary>
  );
}
