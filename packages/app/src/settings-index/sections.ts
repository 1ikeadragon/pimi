import type { TFunction } from "i18next";
import { getDesktopHost } from "@/desktop/host";
import { isWeb } from "@/constants/platform";
import type { HostSectionSlug, SettingsSectionSlug } from "@/utils/host-routes";
import type { SettingsIndexContext } from "./types";

/**
 * The Settings pages themselves: the one place a page's title, availability and search words are
 * declared. The Settings sidebar adds icons and bodies to these; the palette and Settings search
 * index them. A page missing here is missing from both.
 */
interface PageDeclaration<Slug extends string> {
  id: Slug;
  titleKey: string;
  keywords: readonly string[];
  desktopOnly?: boolean;
  webOnly?: boolean;
  hardwareKeyboardOnly?: boolean;
}

export const APP_SETTINGS_PAGES = [
  { id: "general", titleKey: "settings.sections.general", keywords: ["preferences", "options"] },
  {
    id: "appearance",
    titleKey: "settings.sections.appearance",
    keywords: ["look", "theme", "dark", "light", "colors", "fonts", "display"],
  },
  {
    id: "sidebar",
    titleKey: "settings.sections.sidebar",
    keywords: ["navigation", "sections", "left panel"],
  },
  {
    id: "chat",
    titleKey: "settings.sections.chat",
    keywords: ["conversation", "messages", "agent view"],
  },
  { id: "terminal", titleKey: "settings.sections.terminal", keywords: ["shell", "console"] },
  {
    id: "browser",
    titleKey: "settings.sections.browser",
    keywords: ["web", "cookies", "site data"],
    desktopOnly: true,
  },
  {
    id: "editor",
    titleKey: "settings.sections.editor",
    keywords: ["code", "indent", "tabs", "wrap"],
    webOnly: true,
  },
  { id: "files", titleKey: "settings.sections.files", keywords: ["file panel", "viewer", "open"] },
  {
    id: "shortcuts",
    titleKey: "settings.sections.shortcuts",
    keywords: ["keybindings", "hotkeys", "keys", "rebind", "keyboard"],
    hardwareKeyboardOnly: true,
  },
  {
    id: "integrations",
    titleKey: "settings.sections.integrations",
    keywords: ["cli", "command line", "docs"],
    desktopOnly: true,
  },
  {
    id: "notifications",
    titleKey: "settings.sections.notifications",
    keywords: ["alerts", "sounds", "desktop notifications"],
    desktopOnly: true,
  },
  {
    id: "permissions",
    titleKey: "settings.sections.permissions",
    keywords: ["microphone", "access", "privacy"],
    desktopOnly: true,
  },
  {
    id: "diagnostics",
    titleKey: "settings.sections.diagnostics",
    keywords: ["debug", "logs", "audio test", "troubleshoot"],
  },
  {
    id: "network",
    titleKey: "settings.sections.network",
    keywords: ["requests", "traffic", "http", "connections log"],
  },
  {
    id: "about",
    titleKey: "settings.sections.about",
    keywords: ["version", "update", "release", "changelog"],
  },
] as const satisfies readonly PageDeclaration<SettingsSectionSlug>[];

export const HOST_SETTINGS_PAGES = [
  {
    id: "host",
    titleKey: "settings.hostSections.host",
    keywords: ["daemon", "restart", "remove host", "version"],
  },
  {
    id: "projects",
    titleKey: "settings.hostSections.projects",
    keywords: ["repositories", "repos", "folders"],
  },
  {
    id: "connections",
    titleKey: "settings.hostSections.connections",
    keywords: ["address", "relay", "remote", "network"],
  },
  {
    id: "pair-device",
    titleKey: "openProject.tiles.pairDevice.title",
    keywords: ["phone", "mobile", "qr", "pairing"],
  },
  {
    id: "agents",
    titleKey: "settings.hostSections.agents",
    keywords: ["profiles", "defaults", "permissions", "subagents"],
  },
  {
    id: "metadata",
    titleKey: "settings.hostSections.metadata",
    keywords: ["titles", "branch names", "commit messages", "generation"],
  },
  {
    id: "voice",
    titleKey: "settings.hostSections.voice",
    keywords: ["dictation", "speech", "microphone", "whisper", "tts", "stt"],
  },
  {
    id: "workspaces",
    titleKey: "settings.hostSections.workspaces",
    keywords: ["worktrees", "branches", "archive"],
  },
  {
    id: "providers",
    titleKey: "settings.hostSections.providers",
    keywords: ["models", "claude", "codex", "copilot", "opencode", "api key", "login"],
  },
  {
    id: "usage",
    titleKey: "settings.hostSections.usage",
    keywords: ["limits", "quota", "tokens", "cost"],
  },
  {
    id: "terminals",
    titleKey: "settings.hostSections.terminals",
    keywords: ["shell", "profiles", "console"],
  },
  {
    id: "editor",
    titleKey: "settings.hostSections.editor",
    keywords: ["language servers", "lsp", "code intelligence"],
  },
  {
    id: "plugins",
    titleKey: "settings.hostSections.plugins",
    keywords: ["extensions", "mods", "install"],
  },
] as const satisfies readonly PageDeclaration<HostSectionSlug>[];

export type AppPageDeclaration = (typeof APP_SETTINGS_PAGES)[number];
export type HostPageDeclaration = (typeof HOST_SETTINGS_PAGES)[number];

export function appSettingsPage(id: SettingsSectionSlug): AppPageDeclaration {
  const page = APP_SETTINGS_PAGES.find((candidate) => candidate.id === id);
  if (!page) throw new Error(`Unknown settings page: ${id}`);
  return page;
}

export function hostSettingsPage(id: HostSectionSlug): HostPageDeclaration {
  const page = HOST_SETTINGS_PAGES.find((candidate) => candidate.id === id);
  if (!page) throw new Error(`Unknown host settings page: ${id}`);
  return page;
}

export function isAppSettingsPageAvailable(
  page: PageDeclaration<SettingsSectionSlug>,
  ctx: Pick<SettingsIndexContext, "isDesktopApp" | "hardwareKeyboardPresent">,
): boolean {
  if (page.hardwareKeyboardOnly && !ctx.hardwareKeyboardPresent) return false;
  return (!page.desktopOnly || ctx.isDesktopApp) && (!page.webOnly || isWeb);
}

/** Pimi renames the voice page to say what it does. */
export function hostSettingsPageTitle(id: HostSectionSlug, t: TFunction): string {
  const isPimi = Boolean(getDesktopHost()?.showPimiWorkspace);
  if (isPimi && id === "voice") return "Voice & dictation";
  return t(hostSettingsPage(id).titleKey);
}
