// Pimi Android Work view. Apache-2.0.
import { router, type Href } from "expo-router";
import { buildOpenProjectRoute } from "@/utils/host-routes";

export const PIMI_WORK_ROUTE = "/pimi-work";

export function openPimiWork(): void {
  router.navigate(PIMI_WORK_ROUTE as Href);
}

export function closePimiWork(): void {
  if (router.canGoBack()) router.back();
  else router.replace(buildOpenProjectRoute());
}
