// Pimi. PolyForm-Noncommercial-1.0.0.
import { Redirect } from "expo-router";
import { getDesktopHost } from "@/desktop/host";
import { PimiAgentGridScreen } from "@/screens/pimi-agent-grid-screen";
import { buildOpenProjectRoute } from "@/utils/host-routes";
import { isPimiAndroid } from "@/utils/pimi-mobile";

export default function PimiAgentGridRoute() {
  if (!isPimiAndroid() && !getDesktopHost()?.showPimiWorkspace) {
    return <Redirect href={buildOpenProjectRoute()} />;
  }
  return <PimiAgentGridScreen />;
}
