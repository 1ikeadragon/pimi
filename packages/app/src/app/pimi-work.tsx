// Pimi Android Work view. Apache-2.0.
import { Redirect } from "expo-router";
import { PimiWorkScreen } from "@/screens/pimi-work-screen";
import { buildOpenProjectRoute } from "@/utils/host-routes";
import { isPimiAndroid } from "@/utils/pimi-mobile";

export default function PimiWorkRoute() {
  if (!isPimiAndroid()) return <Redirect href={buildOpenProjectRoute()} />;
  return <PimiWorkScreen />;
}
