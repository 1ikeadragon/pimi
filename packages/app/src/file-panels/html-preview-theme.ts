import type { PimiHtmlVariable } from "@pimi/protocol/chat-html";
import type { Theme } from "@/styles/theme";
import type { HtmlPreviewEmbed } from "./html-preview-csp";

// One embed per theme object: a new identity would rebuild the document and restart its script.
const embeds = new WeakMap<Theme, HtmlPreviewEmbed>();

/** The app theme as the `--pimi-*` properties an HTML preview is styled with. For `withUnistyles`. */
export function htmlPreviewTheme(theme: Theme): { embed: HtmlPreviewEmbed } {
  let embed = embeds.get(theme);
  if (!embed) {
    const { colors } = theme;
    embed = {
      colorScheme: theme.colorScheme === "dark" ? "dark" : "light",
      // Typed by the list agents are told, so a property cannot be promised and not supplied.
      variables: {
        bg: colors.surface1,
        surface: colors.surface2,
        fg: colors.foreground,
        muted: colors.foregroundMuted,
        border: colors.border,
        accent: colors.accent,
        "accent-fg": colors.accentForeground ?? colors.foreground,
        font: theme.fontFamily.ui,
        mono: theme.fontFamily.mono,
      } satisfies Record<PimiHtmlVariable, string>,
    };
    embeds.set(theme, embed);
  }
  return { embed };
}
