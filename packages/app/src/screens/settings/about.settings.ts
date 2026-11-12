import { defineSettingsPage } from "@/settings-index/define";
import { isPimiProduct } from "@/utils/pimi-mobile";

export const aboutSettings = defineSettingsPage(
  { kind: "section", section: "about" },
  ({ t, isDesktopApp }) => [
    {
      id: "about.version",
      title: t("settings.about.appVersion"),
      keywords: ["build", "release", "number"],
    },
    {
      id: "about.whatsNew",
      title: t("changelog.title"),
      keywords: ["changelog", "release notes", "updates", "new features"],
    },
    isDesktopApp && !isPimiProduct()
      ? {
          id: "about.releaseChannel",
          title: t("settings.about.releaseChannel.label"),
          keywords: ["beta", "stable", "channel", "updates"],
        }
      : null,
    isDesktopApp
      ? {
          id: "about.updates",
          title: t("settings.about.updates.label"),
          keywords: ["update", "upgrade", "check for updates", "install", "version", "download"],
        }
      : null,
  ],
);
