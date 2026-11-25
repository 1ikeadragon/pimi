import { router, type Href } from "expo-router";
import { getCompactFormFactorSnapshot } from "@/constants/layout";
import { getSettingsHostSelection, isInSettings } from "@/navigation/settings-presentation";
import {
  buildSettingsHostSectionRoute,
  buildSettingsRoute,
  buildSettingsSectionRoute,
} from "@/utils/host-routes";
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

/**
 * Open the page an entry lives on and, for a field, scroll to it and highlight it. From outside
 * Settings it pushes, so Back returns to where the search started. Inside Settings it replaces the
 * page, as the sidebar does, so Back never walks through pages the person did not open: wide
 * layouts swap the detail pane, compact ones go up to the list first and push from there.
 */
export function openSettingEntry(entry: SettingEntry, defaultServerId: string | null): void {
  const inSettings = isInSettings();
  // A host page opens on the host picked in Settings; elsewhere the default host stands in.
  const serverId = inSettings ? (getSettingsHostSelection() ?? defaultServerId) : defaultServerId;
  const route = buildSettingsEntryRoute(entry, serverId);
  if (!route) return;
  if (!entry.isPage) useSettingsFocusStore.getState().focusSetting(entry.id);
  if (!inSettings) router.navigate(route);
  else if (getCompactFormFactorSnapshot()) {
    router.dismissTo(buildSettingsRoute());
    router.push(route);
  } else router.replace(route);
}
