import { Platform } from "react-native";
import { defineSettingsPage } from "@/settings-index/define";

export const pushNotificationsSettings = defineSettingsPage(
  { kind: "section", section: "general" },
  ({ t }) =>
    Platform.OS === "android"
      ? [
          {
            id: "general.pushPreviews",
            title: t("settings.general.notifications.previews.label"),
            keywords: ["notification", "preview", "push", "lock screen", "privacy"],
          },
          {
            id: "general.pushPreviewsHideWhenLocked",
            title: t("settings.general.notifications.hideWhenLocked.label"),
            keywords: ["notification", "preview", "push", "lock screen", "privacy"],
          },
        ]
      : [],
);
