// Pimi addition to the Paseo fork. Apache-2.0.
import { router, type Href } from "expo-router";
import { getDesktopHost } from "@/desktop/host";
import { buildOpenProjectRoute } from "@/utils/host-routes";

export const PIMI_USAGE_ROUTE = "/pimi-usage";

export function openPimiUsage(): void {
  getDesktopHost()?.dismissPimiWorkspace?.();
  router.navigate(PIMI_USAGE_ROUTE as Href);
}

export function closePimiUsage(): void {
  if (router.canGoBack()) router.back();
  else router.replace(buildOpenProjectRoute());
}
