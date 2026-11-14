import { noProps, overridable } from "@/extension-points";
// Pimi. PolyForm-Noncommercial-1.0.0.
import { Redirect } from "expo-router";
import { getDesktopHost } from "@/desktop/host";
import { PimiUsageScreen } from "@/screens/pimi-usage-screen";
import { buildOpenProjectRoute } from "@/utils/host-routes";
import { isPimiAndroid } from "@/utils/pimi-mobile";

const Usage = overridable("screen.usage", PimiUsageScreen, noProps());

export default function PimiUsageRoute() {
  if (!isPimiAndroid() && !getDesktopHost()?.showPimiWorkspace) {
    return <Redirect href={buildOpenProjectRoute()} />;
  }
  return <Usage />;
}
