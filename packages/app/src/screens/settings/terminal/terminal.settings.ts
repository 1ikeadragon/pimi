import { defineSettingsPage } from "@/settings-index/define";

export const terminalSettings = defineSettingsPage(
  { kind: "section", section: "editor" },
  ({ t }) => [
    {
      id: "terminal.scrollback",
      title: t("settings.general.terminalScrollback.label"),
      keywords: ["history", "buffer", "lines", "scroll", "memory"],
    },
  ],
);
