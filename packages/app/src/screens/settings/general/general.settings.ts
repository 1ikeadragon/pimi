import { isNative } from "@/constants/platform";
import { defineSettingsPage } from "@/settings-index/define";

export const generalSettings = defineSettingsPage(
  { kind: "section", section: "general" },
  ({ t }) => [
    {
      id: "general.streamer",
      title: t("settings.general.streamer.label"),
      keywords: ["streaming", "screen share", "privacy", "email", "account", "hide", "recording"],
    },
    isNative
      ? null
      : {
          id: "general.setup",
          title: t("settings.general.setup.label"),
          keywords: ["onboarding", "welcome", "tour", "first run", "again", "restart setup"],
        },
  ],
);
