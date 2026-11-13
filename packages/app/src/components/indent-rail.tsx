import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ACTIVITY_ROW_TEXT_OFFSET } from "@/components/activity-row";

/**
 * The rail runs down the centre of a row's glyph column. Content starts at the row text column,
 * so nested rows put their glyphs under the parent's text.
 */
const RAIL_LEFT = 7;
const RAIL_WIDTH = 1;
export const INDENT_RAIL_CONTENT_OFFSET = ACTIVITY_ROW_TEXT_OFFSET;

/** Indents opened chat rows under the summary that collapsed them, behind a vertical line. */
export function IndentRail({
  children,
  style,
}: {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[styles.rail, style]}>{children}</View>;
}

const styles = StyleSheet.create((theme) => ({
  rail: {
    marginLeft: RAIL_LEFT,
    paddingLeft: INDENT_RAIL_CONTENT_OFFSET - RAIL_LEFT - RAIL_WIDTH,
    borderLeftWidth: RAIL_WIDTH,
    borderLeftColor: theme.colors.border,
  },
}));
