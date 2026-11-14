import { defineSettingsPage } from "@/settings-index/define";

const NAV_KEYWORDS = ["navigation", "hide", "show", "reorder", "move", "items", "links"];

export const sidebarSettings = defineSettingsPage(
  { kind: "section", section: "appearance" },
  ({ t }) => [
    {
      id: "sidebar.header",
      title: t("settings.appearance.sidebar.header.title"),
      keywords: [...NAV_KEYWORDS, "top"],
    },
    {
      id: "sidebar.footer",
      title: t("settings.appearance.sidebar.footer.title"),
      keywords: [...NAV_KEYWORDS, "bottom"],
    },
  ],
);
