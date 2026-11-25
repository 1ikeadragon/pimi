import { Platform } from "react-native";
import { defineSettingsPage } from "@/settings-index/define";

export const pushNotificationsSettings = defineSettingsPage(
  { kind: "section", section: "notifications" },
  ({ t }) =>
    Platform.OS === "android"
      ? [
          {
            id: "notifications.pushPreviews",
            title: t("settings.general.notifications.previews.label"),
            keywords: ["notification", "preview", "push", "lock screen", "privacy"],
          },
          {
            id: "notifications.pushPreviewsHideWhenLocked",
            title: t("settings.general.notifications.hideWhenLocked.label"),
            keywords: ["notification", "preview", "push", "lock screen", "privacy"],
          },
        ]
      : [],
);
