import { isNative } from "@/constants/platform";
import { defineSettingsPage } from "@/settings-index/define";

export const generalSettings = defineSettingsPage(
  { kind: "section", section: "general" },
  ({ t }) => [
    {
      id: "general.language",
      title: t("settings.general.language.label"),
      keywords: ["locale", "translation", "english", "french", "spanish", "japanese", "korean"],
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
