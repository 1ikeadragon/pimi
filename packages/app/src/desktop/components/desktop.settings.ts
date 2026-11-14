import { hasDesktopTargetBridge } from "@/attack/use-desktop-target";
import { defineSettingsPage } from "@/settings-index/define";

export const notificationsSettings = defineSettingsPage(
  { kind: "section", section: "notifications" },
  ({ t }) => [
    {
      id: "notifications.permission",
      title: t("settings.notifications.permission"),
      keywords: ["allow", "enable", "access", "system", "alerts"],
    },
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
    hasDesktopTargetBridge()
      ? {
          id: "permissions.attackAccess",
          title: t("attack.setup.label"),
          keywords: [
            "attack",
            "adversarial",
            "security",
            "qa",
            "accessibility",
            "screen recording",
          ],
        }
      : null,
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
