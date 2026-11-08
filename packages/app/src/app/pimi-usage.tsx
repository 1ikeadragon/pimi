// Pimi addition to the Paseo fork. Apache-2.0.
import { Redirect } from "expo-router";
import { getDesktopHost } from "@/desktop/host";
import { PimiUsageScreen } from "@/screens/pimi-usage-screen";
import { buildOpenProjectRoute } from "@/utils/host-routes";
import { isPimiAndroid } from "@/utils/pimi-mobile";

export default function PimiUsageRoute() {
  if (!isPimiAndroid() && !getDesktopHost()?.showPimiWorkspace) {
    return <Redirect href={buildOpenProjectRoute()} />;
  }
  return <PimiUsageScreen />;
}
