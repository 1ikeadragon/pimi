import { isWeb } from "@/constants/platform";
import { defineSettingsPage } from "@/settings-index/define";

export const editorSettings = defineSettingsPage(
  { kind: "section", section: "editor" },
  ({ t }) => [
    isWeb
      ? {
          id: "editor.vim",
          title: t("settings.editor.vimKeybindings"),
          keywords: ["vim", "modal", "keybindings", "keys", "normal mode", "code editor"],
        }
      : null,
    isWeb
      ? {
          id: "editor.inlineDiff",
          title: t("settings.editor.inlineDiff"),
          keywords: ["diff", "changes", "git", "highlight", "modified lines", "head"],
        }
      : null,
    {
      id: "editor.files",
      title: t("settings.files.title"),
      keywords: ["file panels", "open with", "viewer", "default app", "file types"],
    },
  ],
);
