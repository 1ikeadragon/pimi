import { overridable } from "@/extension-points";
// Pimi. Apache-2.0.
import { Redirect, useLocalSearchParams } from "expo-router";
import { getDesktopHost } from "@/desktop/host";
import { PimiLibraryScreen } from "@/screens/pimi-library-screen";
import { buildOpenProjectRoute } from "@/utils/host-routes";

const Library = overridable("screen.library", PimiLibraryScreen, {
  toPlugin: ({ section }) => ({ section }),
  merge: (core, patch) => ({ section: patch.section ?? core.section }),
});

export default function PimiLibraryRoute() {
  const { section } = useLocalSearchParams<{ section?: string }>();
  if (!getDesktopHost()?.showPimiWorkspace) return <Redirect href={buildOpenProjectRoute()} />;
  return <Library section={section === "hooks" ? "hooks" : "skills"} />;
}
