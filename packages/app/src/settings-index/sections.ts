import type { TFunction } from "i18next";
import { Platform } from "react-native";
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
  /** Pages with rows only on some runtimes, such as notifications, hide themselves elsewhere. */
  available?(ctx: Pick<SettingsIndexContext, "isDesktopApp">): boolean;
  hardwareKeyboardOnly?: boolean;
}

/** The sidebar's labelled sub-groups of host pages, in display order. */
export const HOST_PAGE_GROUPS = ["agents", "security", "workspace", "thisHost"] as const;
export type HostPageGroup = (typeof HOST_PAGE_GROUPS)[number];

interface HostPageShape extends PageDeclaration<HostSectionSlug> {
  group: HostPageGroup;
}

export const APP_SETTINGS_PAGES = [
  {
    id: "general",
    titleKey: "settings.sections.general",
    keywords: ["preferences", "options", "cli", "command line", "setup"],
  },
  {
    id: "appearance",
    titleKey: "settings.sections.appearance",
    keywords: ["look", "theme", "dark", "light", "colors", "fonts", "display", "sidebar items"],
  },
  {
    id: "chat",
    titleKey: "settings.sections.chat",
    keywords: ["conversation", "messages", "agent view", "send", "composer"],
  },
  {
    id: "editor",
    titleKey: "settings.sections.editor",
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
    keywords: ["keybindings", "hotkeys", "keys", "rebind", "keyboard"],
    hardwareKeyboardOnly: true,
  },
  {
    id: "notifications",
    titleKey: "settings.sections.notifications",
    keywords: ["alerts", "sounds", "microphone", "permissions", "privacy", "push", "desktop"],
    available: ({ isDesktopApp }) => isDesktopApp || Platform.OS === "android",
  },
  {
    id: "about",
    titleKey: "settings.sections.about",
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
    group: "agents",
    keywords: ["models", "claude", "codex", "copilot", "opencode", "api key", "login"],
  },
  {
    id: "metadata",
    titleKey: "settings.hostSections.metadata",
    group: "agents",
    keywords: ["titles", "branch names", "commit messages", "generation"],
  },
  {
    id: "agents",
    titleKey: "settings.hostSections.agents",
    group: "agents",
    keywords: ["tools", "instructions", "lifecycle", "archive", "terminal agents"],
  },
  {
    id: "voice",
    titleKey: "settings.hostSections.voice",
    group: "agents",
    keywords: ["dictation", "speech", "microphone", "whisper", "tts", "stt"],
  },
  {
    id: "vault",
    titleKey: "settings.hostSections.vault",
    group: "security",
    keywords: [
      "secrets",
      "security",
      "credentials",
      "api key",
      "token",
      "password",
      "passphrase",
      "bitwarden",
      "env",
      "approvals",
    ],
  },
  {
    id: "trust",
    titleKey: "settings.hostSections.trust",
    group: "security",
    keywords: ["security", "permissions", "browser", "supply chain", "packages", "agent access"],
  },
  {
    id: "projects",
    titleKey: "settings.hostSections.projects",
    group: "workspace",
    keywords: ["repositories", "repos", "folders"],
  },
  {
    id: "terminals",
    titleKey: "settings.hostSections.terminals",
    group: "workspace",
    keywords: ["shell", "profiles", "console", "language servers", "lsp", "code intelligence"],
  },
  {
    id: "plugins",
    titleKey: "settings.hostSections.plugins",
    group: "workspace",
    keywords: ["extensions", "mods", "install"],
  },
  {
    id: "host",
    titleKey: "settings.hostSections.host",
    group: "thisHost",
    keywords: [
      "host",
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
  {
    id: "resources",
    titleKey: "settings.hostSections.resources",
    group: "thisHost",
    keywords: ["network", "requests", "traffic", "cpu", "memory", "processes", "logs"],
  },
] as const satisfies readonly HostPageShape[];

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
  return page.available?.(ctx) ?? true;
}

export function hostSettingsPageTitle(id: HostSectionSlug, t: TFunction): string {
  return t(hostSettingsPage(id).titleKey);
}
