import { createContext, useContext, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { X } from "lucide-react-native";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const ThemedX = withUnistyles(X);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * What a tray pill lends the chip it wraps: while the pointer is on it (always, where there is no
 * pointer) the chip's type icon becomes the remove button, so the chip never changes size.
 */
interface ChipRemoval {
  hovered: boolean;
  disabled: boolean;
  label: string;
  onRemove: () => void;
}

export const ChipRemovalContext = createContext<ChipRemoval | null>(null);

interface InlineChipProps {
  icon: ReactNode;
  label: string;
  hasNote?: boolean;
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
  selected = false,
  focused = false,
  size = "inline",
  testID,
}: InlineChipProps) {
  const removal = useContext(ChipRemovalContext);
  const compact = useIsCompactFormFactor();
  const touch = size === "tray" && (compact || isNative);
  const showRemove = removal !== null && (removal.hovered || touch);
  styles.useVariants({ size, touch, selected, focused });
  return (
    <View style={styles.chip} testID={testID}>
      {showRemove ? (
        <Pressable
          onPress={removal.onRemove}
          disabled={removal.disabled}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={removal.label}
          style={styles.iconSlot}
        >
          <ThemedX size={ICON_SIZE.xs} uniProps={mutedIconMapping} />
        </Pressable>
      ) : (
        <View style={styles.iconSlot}>{icon}</View>
      )}
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
  noteDot: {
    width: 5,
    height: 5,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accentBright,
  },
}));
