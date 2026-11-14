// Pimi. PolyForm-Noncommercial-1.0.0.
import { router } from "expo-router";
import { getDesktopHost } from "@/desktop/host";
import { buildOpenProjectRoute } from "@/utils/host-routes";

export const PIMI_LIBRARY_ROUTE = "/pimi-library";
export type PimiLibrarySection = "skills" | "hooks";

export function openPimiLibrary(section: PimiLibrarySection, alreadyOpen: boolean): void {
  getDesktopHost()?.dismissPimiWorkspace?.();
  if (alreadyOpen) router.setParams({ section });
  else router.navigate({ pathname: PIMI_LIBRARY_ROUTE, params: { section } });
}

export function closePimiLibrary(): void {
  if (router.canGoBack()) router.back();
  else router.replace(buildOpenProjectRoute());
}
