import { overridable } from "@/extension-points";
// Pimi. PolyForm-Noncommercial-1.0.0.
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
  // Flows and prompts run from any chat, so their libraries open in the browser and on a phone too.
  const isChatLibrary = section === "flows" || section === "prompts";
  if (!isChatLibrary && !getDesktopHost()?.showPimiWorkspace) {
    return <Redirect href={buildOpenProjectRoute()} />;
  }
  return <Library section={isChatLibrary || section === "hooks" ? section : "skills"} />;
}
