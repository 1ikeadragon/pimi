// Pimi. Apache-2.0.
import { router, type Href } from "expo-router";
import { getDesktopHost } from "@/desktop/host";
import { buildOpenProjectRoute } from "@/utils/host-routes";
import type { PimiVoiceUsageTab } from "@pimi/protocol/pimi-task";
import type { z } from "zod";

export const PIMI_USAGE_ROUTE = "/pimi-usage";

export function openPimiUsage(): void {
  getDesktopHost()?.dismissPimiWorkspace?.();
  router.navigate(PIMI_USAGE_ROUTE as Href);
}

export function openPimiUsageDetail(
  input: {
    tab: z.infer<typeof PimiVoiceUsageTab>;
    session?: string;
    serverId?: string;
    agentId?: string;
  },
  alreadyOpen: boolean,
): void {
  getDesktopHost()?.dismissPimiWorkspace?.();
  const params = {
    tab: input.tab,
    session: input.session ?? "",
    serverId: input.serverId ?? "",
    agentId: input.agentId ?? "",
  };
  if (alreadyOpen) router.setParams(params);
  else router.navigate({ pathname: PIMI_USAGE_ROUTE, params });
}

export function closePimiUsage(): void {
  if (router.canGoBack()) router.back();
  else router.replace(buildOpenProjectRoute());
}
