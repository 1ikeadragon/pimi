import { aboutSettings } from "@/screens/settings/about.settings";
import { chatSettings } from "@/screens/settings/chat/chat.settings";
import { diagnosticsSettings } from "@/screens/settings/diagnostics.settings";
import { editorSettings } from "@/screens/settings/editor.settings";
import { generalSettings } from "@/screens/settings/general/general.settings";
import { sendingSettings } from "@/screens/settings/general/sending.settings";
import { openLocationSettings } from "@/screens/settings/open-location/open-location.settings";
import { appearanceSettings } from "@/screens/settings/appearance/appearance.settings";
import { sidebarSettings } from "@/screens/settings/sidebar/sidebar.settings";
import { terminalSettings } from "@/screens/settings/terminal/terminal.settings";
import { browserSettings } from "@/desktop/browser/settings/browser.settings";
import {
  integrationsSettings,
  notificationsSettings,
  permissionsSettings,
} from "@/desktop/components/desktop.settings";
import {
  APP_SETTINGS_PAGES,
  HOST_SETTINGS_PAGES,
  hostSettingsPageTitle,
  isAppSettingsPageAvailable,
} from "./sections";
import type { SettingEntry, SettingsIndexContext, SettingsLocation, SettingsPage } from "./types";

/**
 * Every page that declares searchable fields. A page without fields still appears as a whole
 * page, from `sections.ts`. Add a page's declarations here; delete the line to drop them.
 */
const SETTINGS_PAGES: readonly SettingsPage[] = [
  generalSettings,
  sendingSettings,
  openLocationSettings,
  appearanceSettings,
  sidebarSettings,
  chatSettings,
  terminalSettings,
  browserSettings,
  editorSettings,
  integrationsSettings,
  notificationsSettings,
  permissionsSettings,
  diagnosticsSettings,
  aboutSettings,
];

function sameLocation(left: SettingsLocation, right: SettingsLocation): boolean {
  return left.kind === right.kind && left.section === right.section;
}

function pageTitleOf(location: SettingsLocation, ctx: SettingsIndexContext): string {
  if (location.kind === "host") return hostSettingsPageTitle(location.section, ctx.t);
  const page = APP_SETTINGS_PAGES.find((candidate) => candidate.id === location.section);
  return page ? ctx.t(page.titleKey) : location.section;
}

/** The fields one page declares, in declaration order. Empty when the page is not available. */
export function collectPageFieldEntries(
  location: SettingsLocation,
  ctx: SettingsIndexContext,
): SettingEntry[] {
  if (location.kind === "section") {
    const page = APP_SETTINGS_PAGES.find((candidate) => candidate.id === location.section);
    if (!page || !isAppSettingsPageAvailable(page, ctx)) return [];
  }
  const pageTitle = pageTitleOf(location, ctx);
  const entries: SettingEntry[] = [];
  for (const source of SETTINGS_PAGES) {
    if (!sameLocation(source.location, location)) continue;
    for (const declaration of source.declare(ctx)) {
      if (declaration) entries.push({ ...declaration, location, pageTitle, isPage: false });
    }
  }
  return entries;
}

/**
 * The whole index for this runtime: each available page, then that page's fields. One list for
 * the palette and the Settings search field, so both rank the same rows the same way.
 */
export function collectSettingEntries(ctx: SettingsIndexContext): SettingEntry[] {
  const entries: SettingEntry[] = [];
  for (const page of APP_SETTINGS_PAGES) {
    if (!isAppSettingsPageAvailable(page, ctx)) continue;
    const location: SettingsLocation = { kind: "section", section: page.id };
    const pageTitle = ctx.t(page.titleKey);
    entries.push({
      id: `page.${page.id}`,
      title: pageTitle,
      keywords: page.keywords,
      location,
      pageTitle,
      isPage: true,
    });
    entries.push(...collectPageFieldEntries(location, ctx));
  }
  for (const page of HOST_SETTINGS_PAGES) {
    const location: SettingsLocation = { kind: "host", section: page.id };
    const pageTitle = hostSettingsPageTitle(page.id, ctx.t);
    entries.push({
      id: `host.${page.id}`,
      title: pageTitle,
      keywords: page.keywords,
      location,
      pageTitle,
      isPage: true,
    });
    entries.push(...collectPageFieldEntries(location, ctx));
  }
  return entries;
}
