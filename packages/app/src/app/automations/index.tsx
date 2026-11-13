import { noProps, overridable } from "@/extension-points";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { AutomationsScreen } from "@/screens/automations-screen";

const Automations = overridable("screen.automations", AutomationsScreen, noProps());

export default function AutomationsRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <Automations />
    </HostRouteBootstrapBoundary>
  );
}
