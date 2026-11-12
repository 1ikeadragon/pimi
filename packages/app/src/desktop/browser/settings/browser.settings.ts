import { defineSettingsPage } from "@/settings-index/define";

export const browserSettings = defineSettingsPage(
  { kind: "section", section: "browser" },
  ({ t }) => [
    {
      id: "browser.siteData",
      title: t("settings.general.browserData.siteData"),
      keywords: ["cookies", "cache", "storage", "clear", "logins", "sessions", "privacy"],
    },
  ],
);
