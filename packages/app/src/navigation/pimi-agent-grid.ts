// Pimi addition to the Paseo fork. Apache-2.0.
import { router, type Href } from "expo-router";
import { getDesktopHost } from "@/desktop/host";
import { buildOpenProjectRoute } from "@/utils/host-routes";

export const PIMI_AGENT_GRID_ROUTE = "/pimi-agent-grid";

export function openPimiAgentGrid(): void {
  getDesktopHost()?.dismissPimiWorkspace?.();
  router.navigate(PIMI_AGENT_GRID_ROUTE as Href);
}

export function closePimiAgentGrid(): void {
  if (router.canGoBack()) router.back();
  else router.replace(buildOpenProjectRoute());
}
