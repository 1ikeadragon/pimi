import { router, type Href } from "expo-router";
import { buildSettingsHostSectionRoute, buildSettingsSectionRoute } from "@/utils/host-routes";
import { useSettingsFocusStore } from "./focus";
import type { SettingEntry } from "./types";

/**
 * The route of a Settings page. Host pages belong to one host, so they need its id; app pages
 * do not.
 */
export function buildSettingsEntryRoute(entry: SettingEntry, serverId: string | null): Href | null {
  if (entry.location.kind === "section") return buildSettingsSectionRoute(entry.location.section);
  return serverId ? buildSettingsHostSectionRoute(serverId, entry.location.section) : null;
}

/** Open the page an entry lives on and, for a field, scroll to it and highlight it. */
export function openSettingEntry(entry: SettingEntry, serverId: string | null): void {
  const route = buildSettingsEntryRoute(entry, serverId);
  if (!route) return;
  if (!entry.isPage) useSettingsFocusStore.getState().focusSetting(entry.id);
  router.navigate(route);
}
