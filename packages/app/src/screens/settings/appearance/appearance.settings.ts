import { isNative } from "@/constants/platform";
import { defineSettingsPage } from "@/settings-index/define";

export const appearanceSettings = defineSettingsPage(
  { kind: "section", section: "appearance" },
  ({ t }) => [
    {
      id: "appearance.theme",
      title: t("settings.appearance.theme.title"),
      keywords: ["dark mode", "light mode", "color scheme", "colors", "appearance"],
    },
    isNative
      ? null
      : {
          id: "appearance.interfaceFont",
          title: t("settings.appearance.fonts.interfaceFont"),
          keywords: ["font", "typeface", "ui font", "text"],
        },
    {
      id: "appearance.interfaceSize",
      title: t("settings.appearance.fonts.interfaceSize"),
      keywords: ["font size", "zoom", "scale", "text size", "ui size"],
    },
    {
      id: "appearance.contentSize",
      title: t("settings.appearance.fonts.contentSize"),
      keywords: ["font size", "message size", "chat text", "text size", "reading"],
    },
    {
      id: "appearance.codeFont",
      title: t("settings.appearance.fonts.codeFont"),
      keywords: ["font", "monospace", "mono", "typeface", "terminal font", "editor font"],
    },
    {
      id: "appearance.codeSize",
      title: t("settings.appearance.fonts.codeSize"),
      keywords: ["font size", "monospace", "code text", "editor size", "terminal size"],
    },
    {
      id: "appearance.contentWidth",
      title: t("settings.appearance.layout.contentWidth"),
      keywords: ["max width", "column", "wide", "narrow", "layout"],
    },
    {
      id: "appearance.syntaxTheme",
      title: t("settings.appearance.syntax.highlightTheme"),
      keywords: ["syntax highlighting", "code colors", "highlight"],
    },
  ],
);
