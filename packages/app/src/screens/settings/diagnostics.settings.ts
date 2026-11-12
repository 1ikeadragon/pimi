import { defineSettingsPage } from "@/settings-index/define";

export const diagnosticsSettings = defineSettingsPage(
  { kind: "section", section: "diagnostics" },
  ({ t }) => [
    {
      id: "diagnostics.app",
      title: t("settings.diagnostics.app.rowTitle"),
      keywords: ["check", "health", "troubleshoot", "debug", "problems", "report"],
    },
    {
      id: "diagnostics.audio",
      title: t("settings.diagnostics.testAudio"),
      keywords: ["sound", "speaker", "playback", "volume", "tone"],
    },
  ],
);
