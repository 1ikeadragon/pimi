import { isNative } from "@/constants/platform";
import { getDesktopHost } from "@/desktop/host";
import { defineSettingsPage } from "@/settings-index/define";

export const chatSettings = defineSettingsPage({ kind: "section", section: "chat" }, ({ t }) => [
  getDesktopHost()?.pimiVoice
    ? {
        id: "chat.voiceButton",
        title: "Show Pimi voice button",
        keywords: ["voice", "microphone", "speak", "dictation", "commands", "mascot"],
      }
    : null,
  {
    id: "chat.autoExpandReasoning",
    title: t("settings.general.autoExpandReasoning.label"),
    keywords: ["thinking", "reasoning", "expand", "collapse", "chain of thought"],
  },
  {
    id: "chat.display",
    title: t("settings.general.chatDisplay.label"),
    keywords: ["tool calls", "collapse", "turns", "detail", "verbosity", "full", "compact"],
  },
  isNative
    ? null
    : {
        id: "chat.outline",
        title: t("settings.appearance.chatOutline.title"),
        keywords: ["outline", "table of contents", "navigation", "minimap", "headings"],
      },
]);
