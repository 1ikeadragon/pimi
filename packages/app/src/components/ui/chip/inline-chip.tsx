import { createContext, useContext, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { X } from "lucide-react-native";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const ThemedX = withUnistyles(X);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * What a tray pill lends the chip it wraps: while the pointer is on it (always, where there is no
 * pointer) the chip's type icon becomes the remove glyph, so the chip never changes size. The pill
 * owns the press target; the chip only paints, because it sits inside the pill's open button.
 */
interface ChipRemoval {
  active: boolean;
}

export const ChipRemovalContext = createContext<ChipRemoval | null>(null);

interface InlineChipProps {
  icon: ReactNode;
  label: string;
  hasNote?: boolean;
  /** A circled numeral tying a tray chip to its place in a text that cannot draw chips (native). */
  badge?: string;
  selected?: boolean;
  focused?: boolean;
  /** `inline` sits in a line of text; `tray` is the larger target in the attachment tray. */
  size?: "inline" | "tray";
  testID?: string;
}

/**
 * The one look for things attached to a message: a quiet filled capsule with a type icon and a
 * truncated label. It paints only; pressing, hover cards and removal belong to the caller.
 */
export function InlineChip({
  icon,
  label,
  hasNote = false,
  badge,
  selected = false,
  focused = false,
  size = "inline",
  testID,
}: InlineChipProps) {
  const removal = useContext(ChipRemovalContext);
  const compact = useIsCompactFormFactor();
  const touch = size === "tray" && (compact || isNative);
  const showRemove = removal?.active === true;
  styles.useVariants({ size, touch, selected, focused });
  return (
    <View style={styles.chip} testID={testID}>
      {showRemove ? (
        <View style={styles.iconSlot}>
          <ThemedX size={ICON_SIZE.xs} uniProps={mutedIconMapping} />
        </View>
      ) : (
        <View style={styles.iconSlot}>{icon}</View>
      )}
      {badge ? <Text style={styles.badge}>{badge}</Text> : null}
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
      {hasNote ? <View style={styles.noteDot} /> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    maxWidth: 260,
    paddingHorizontal: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    // A fill over whatever the chip sits on, so it reads on every surface in both themes.
    backgroundColor: theme.colors.interactionHighlight,
    // Always present so focus changes the colour and never the size.
    borderWidth: theme.borderWidth[1],
    borderColor: "transparent",
    variants: {
      size: {
        inline: { height: 20 },
        tray: { height: 24 },
      },
      touch: {
        true: { height: 28, paddingHorizontal: theme.spacing[2] },
        false: {},
      },
      selected: {
        true: { borderColor: theme.colors.foregroundExtraMuted },
        false: {},
      },
      focused: {
        true: { borderColor: theme.colors.accent },
        false: {},
      },
    },
  },
  iconSlot: {
    width: ICON_SIZE.xs,
    height: ICON_SIZE.xs,
    alignItems: "center",
    justifyContent: "center",
  },
  label: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  badge: {
    color: theme.colors.accentBright,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  noteDot: {
    width: 5,
    height: 5,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accentBright,
  },
}));
