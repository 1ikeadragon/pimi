import { StyleSheet } from "react-native-unistyles";

/**
 * The card chrome of the annotation editor, for cards that sit in the chat timeline: a popover
 * surface with an accent border, a `lg` radius, tight padding and gaps, and a `md` shadow.
 * Text inside sits on the card's inner rail with `paddingHorizontal: spacing[1]`.
 */
export const cardStyles = StyleSheet.create((theme) => ({
  surface: {
    backgroundColor: theme.colors.popover,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[2],
    gap: theme.spacing[1],
    ...theme.shadow.md,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
  },
  title: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  text: {
    paddingHorizontal: theme.spacing[1],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  footer: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[1],
  },
}));
