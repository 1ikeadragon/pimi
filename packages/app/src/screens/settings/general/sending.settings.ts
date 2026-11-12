import { supportsConfigurableComposerSendKeys } from "@/keyboard";
import { defineSettingsPage } from "@/settings-index/define";

export const sendingSettings = defineSettingsPage(
  { kind: "section", section: "general" },
  ({ t, hardwareKeyboardPresent }) => [
    hardwareKeyboardPresent && supportsConfigurableComposerSendKeys
      ? {
          id: "general.sendShortcut",
          title: t("settings.general.sendShortcut.label"),
          keywords: ["send", "enter", "submit", "message", "composer", "keyboard", "cmd enter"],
        }
      : null,
    {
      id: "general.defaultSend",
      title: t("settings.general.defaultSend.label"),
      keywords: ["send", "queue", "interrupt", "steer", "busy agent", "message", "composer"],
    },
  ],
);
