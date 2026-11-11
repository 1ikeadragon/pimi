import type { PluginScreenLocation, PluginScreenParams } from "@pimi/plugin/client";
import {
  parsePluginScreenParams,
  parsePluginSurfaceRoute,
  pluginScreenParamsFromRoute,
} from "./routes";
import type { InstalledPlugin } from "./types";
import type { PluginCatalogStatus } from "./registry";
import type { HostRuntimeConnectionStatus } from "@/runtime/host-runtime";

export type PluginSurfacePlaceholderStatus = "loading" | "offline" | "error" | "unavailable";

interface PluginSurfacePlaceholderInput {
  connectionStatus: HostRuntimeConnectionStatus;
  catalogStatus: PluginCatalogStatus;
}

export function resolvePluginSurfacePlaceholder({
  connectionStatus,
  catalogStatus,
}: PluginSurfacePlaceholderInput): PluginSurfacePlaceholderStatus {
  if (connectionStatus === "offline" || connectionStatus === "error") return "offline";
  if (connectionStatus !== "online") return "loading";
  if (catalogStatus === "loading") return "loading";
  if (catalogStatus === "error") return "error";
  return "unavailable";
}

export interface PluginSurfaceContributionIdentity {
  kind: "surface";
  id: string;
}

export function resolvePluginSurfaceContribution(
  plugin: InstalledPlugin | null,
  identity: PluginSurfaceContributionIdentity | null,
): InstalledPlugin["surfaces"][number] | null {
  if (!identity || !plugin) return null;
  return plugin.surfaces.find((contribution) => contribution.id === identity.id) ?? null;
}

/**
 * The screen header's title. A title function that throws or returns an empty string falls back to
 * the screen id, so a bad title never takes the screen down.
 */
export function resolvePluginScreenTitle(
  screen: InstalledPlugin["surfaces"][number],
  params: PluginScreenParams,
  resolve: (text: import("@pimi/plugin/client").PluginText) => string,
): string {
  if (typeof screen.title !== "function") return resolve(screen.title);
  try {
    const title = resolve(screen.title(params));
    if (typeof title === "string" && title.trim()) return title.trim();
  } catch (error) {
    console.warn(`[Plugins] Screen ${screen.id} title failed`, error);
  }
  return screen.id;
}

/**
 * The installation's screen open at `pathname` with the route's search params, or null when the
 * route shows anything else.
 */
export function currentPluginScreen(
  plugin: InstalledPlugin,
  pathname: string,
  routeParams: Readonly<Record<string, string | string[] | undefined>>,
): PluginScreenLocation | null {
  const route = parsePluginSurfaceRoute(pathname);
  if (!route || route.serverId !== plugin.serverId || route.pluginId !== plugin.id) return null;
  const screenId = resolvePluginSurfaceContribution(plugin, route.identity)?.id;
  return screenId ? { screenId, params: pluginScreenParamsFromRoute(routeParams) } : null;
}

/** Checks an `openScreen` input against the installation's screens. Throws when it is invalid. */
export function parsePluginOpenScreenInput(
  plugin: InstalledPlugin,
  input: unknown,
): PluginScreenLocation {
  if (typeof input !== "object" || input === null || !("screenId" in input)) {
    throw new Error("openScreen takes { screenId, params? }");
  }
  const { screenId } = input;
  if (typeof screenId !== "string" || !plugin.surfaces.some((surface) => surface.id === screenId)) {
    throw new Error(`Plugin screen is unavailable: ${String(screenId)}`);
  }
  const params = "params" in input ? input.params : undefined;
  return { screenId, params: parsePluginScreenParams(params) };
}

export function getPluginSurfaceContributionServerIds(
  installations: readonly InstalledPlugin[],
  pluginId: string,
  identity: PluginSurfaceContributionIdentity,
): string[] {
  return installations
    .filter(
      (installation) =>
        installation.id === pluginId &&
        resolvePluginSurfaceContribution(installation, identity) !== null,
    )
    .map((installation) => installation.serverId);
}
