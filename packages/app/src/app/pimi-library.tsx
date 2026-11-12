// Pimi. Apache-2.0.
import { Redirect, useLocalSearchParams } from "expo-router";
import { getDesktopHost } from "@/desktop/host";
import { PimiLibraryScreen } from "@/screens/pimi-library-screen";
import { buildOpenProjectRoute } from "@/utils/host-routes";

export default function PimiLibraryRoute() {
  const { section } = useLocalSearchParams<{ section?: string }>();
  if (!getDesktopHost()?.showPimiWorkspace) return <Redirect href={buildOpenProjectRoute()} />;
  return <PimiLibraryScreen section={section === "hooks" ? "hooks" : "skills"} />;
}
