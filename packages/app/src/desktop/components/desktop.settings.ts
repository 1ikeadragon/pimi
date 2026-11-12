import { getDesktopHost } from "@/desktop/host";
import { defineSettingsPage } from "@/settings-index/define";

export const notificationsSettings = defineSettingsPage(
  { kind: "section", section: "notifications" },
  ({ t }) => [
    {
      id: "notifications.permission",
      title: t("settings.notifications.permission"),
      keywords: ["allow", "enable", "access", "system", "alerts"],
    },
    getDesktopHost()?.pimiAppearance
      ? {
          id: "notifications.task",
          title: t("settings.notifications.taskTitle"),
          keywords: ["tasks", "done", "finished", "alerts"],
        }
      : null,
    {
      id: "notifications.sound",
      title: t("settings.notifications.playSound"),
      keywords: ["audio", "ding", "chime", "mute", "silent"],
    },
    {
      id: "notifications.test",
      title: t("settings.notifications.test"),
      keywords: ["send", "try", "check"],
    },
  ],
);

export const permissionsSettings = defineSettingsPage(
  { kind: "section", section: "permissions" },
  ({ t }) => [
    {
      id: "permissions.microphone",
      title: t("settings.permissions.microphone"),
      keywords: ["mic", "voice", "dictation", "recording", "allow", "access"],
    },
  ],
);

export const integrationsSettings = defineSettingsPage(
  { kind: "section", section: "integrations" },
  ({ t }) => [
    {
      id: "integrations.cli",
      title: t("settings.integrations.commandLine.title"),
      keywords: ["cli", "terminal", "install", "pimi command", "shell", "path"],
    },
  ],
);
