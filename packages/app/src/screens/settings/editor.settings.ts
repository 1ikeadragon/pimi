import { defineSettingsPage } from "@/settings-index/define";

export const editorSettings = defineSettingsPage(
  { kind: "section", section: "editor" },
  ({ t }) => [
    {
      id: "editor.vim",
      title: t("settings.editor.vimKeybindings"),
      keywords: ["vim", "modal", "keybindings", "keys", "normal mode", "code editor"],
    },
  ],
);
