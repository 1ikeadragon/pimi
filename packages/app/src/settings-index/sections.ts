import type { TFunction } from "i18next";
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
  hardwareKeyboardOnly?: boolean;
  /** The Settings sidebar group of an app page: this device ("pimi") or the app itself ("system"). */
  group?: "pimi" | "system";
}

export const APP_SETTINGS_PAGES = [
  {
    id: "general",
    titleKey: "settings.sections.general",
    group: "pimi",
    keywords: ["preferences", "options", "cli", "command line", "setup"],
  },
  {
    id: "appearance",
    titleKey: "settings.sections.appearance",
    group: "pimi",
    keywords: ["look", "theme", "dark", "light", "colors", "fonts", "display", "sidebar items"],
  },
  {
    id: "chat",
    titleKey: "settings.sections.chat",
    group: "pimi",
    keywords: ["conversation", "messages", "agent view", "send", "composer"],
  },
  {
    id: "editor",
    titleKey: "settings.sections.editor",
    group: "pimi",
    keywords: [
      "code",
      "vim",
      "file panel",
      "viewer",
      "terminal",
      "shell",
      "console",
      "scrollback",
      "browser",
      "cookies",
      "site data",
    ],
  },
  {
    id: "shortcuts",
    titleKey: "settings.sections.shortcuts",
    group: "pimi",
    keywords: ["keybindings", "hotkeys", "keys", "rebind", "keyboard"],
    hardwareKeyboardOnly: true,
  },
  {
    id: "desktop",
    titleKey: "settings.sections.desktop",
    group: "system",
    keywords: ["notifications", "alerts", "sounds", "microphone", "permissions", "privacy"],
    desktopOnly: true,
  },
  {
    id: "network",
    titleKey: "settings.sections.network",
    group: "system",
    keywords: ["requests", "traffic", "http", "connections log"],
  },
  {
    id: "about",
    titleKey: "settings.sections.about",
    group: "system",
    keywords: [
      "version",
      "update",
      "release",
      "changelog",
      "diagnostics",
      "debug",
      "logs",
      "audio test",
      "troubleshoot",
    ],
  },
] as const satisfies readonly PageDeclaration<SettingsSectionSlug>[];

export const HOST_SETTINGS_PAGES = [
  {
    id: "providers",
    titleKey: "settings.hostSections.providers",
    keywords: ["models", "claude", "codex", "copilot", "opencode", "api key", "login"],
  },
  {
    id: "metadata",
    titleKey: "settings.hostSections.metadata",
    keywords: ["titles", "branch names", "commit messages", "generation"],
  },
  {
    id: "agents",
    titleKey: "settings.hostSections.agents",
    keywords: ["profiles", "defaults", "permissions", "subagents", "archive", "worktrees"],
  },
  {
    id: "voice",
    titleKey: "settings.hostSections.voice",
    keywords: ["dictation", "speech", "microphone", "whisper", "tts", "stt"],
  },
  {
    id: "projects",
    titleKey: "settings.hostSections.projects",
    keywords: ["repositories", "repos", "folders"],
  },
  {
    id: "usage",
    titleKey: "settings.hostSections.usage",
    keywords: ["limits", "quota", "tokens", "cost"],
  },
  {
    id: "terminals",
    titleKey: "settings.hostSections.terminals",
    keywords: ["shell", "profiles", "console", "language servers", "lsp", "code intelligence"],
  },
  {
    id: "plugins",
    titleKey: "settings.hostSections.plugins",
    keywords: ["extensions", "mods", "install"],
  },
  {
    id: "host",
    titleKey: "settings.hostSections.host",
    keywords: [
      "daemon",
      "restart",
      "remove host",
      "version",
      "connections",
      "address",
      "relay",
      "remote",
      "pair",
      "phone",
      "mobile",
      "qr",
    ],
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
  return !page.desktopOnly || ctx.isDesktopApp;
}

export function hostSettingsPageTitle(id: HostSectionSlug, t: TFunction): string {
  return t(hostSettingsPage(id).titleKey);
}
