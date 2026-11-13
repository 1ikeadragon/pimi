import { memo, useEffect } from "react";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ActivityTextProps } from "./activity-text.types";

const KEYFRAME_ID = "pimi-activity-shimmer-keyframes";
const ANIMATION_NAME = "pimi-activity-shimmer";
const KEYFRAME_CSS = `
  @keyframes ${ANIMATION_NAME} {
    from { background-position: 100% 0; }
    to { background-position: 0% 0; }
  }
`;

function ensureShimmerKeyframes() {
  if (typeof document === "undefined" || document.getElementById(KEYFRAME_ID)) {
    return;
  }
  const element = document.createElement("style");
  element.id = KEYFRAME_ID;
  element.textContent = KEYFRAME_CSS;
  document.head.appendChild(element);
}

/**
 * One text element carrying verb and target. While running, a gradient from the muted to the
 * foreground token is clipped to the glyphs and swept across, so the sweep follows the theme and
 * needs no measurement.
 */
export const ActivityText = memo(function ActivityText({
  verb,
  target,
  targetMono = false,
  emphasized,
  running,
  shimmer,
}: ActivityTextProps) {
  useEffect(() => {
    if (shimmer) ensureShimmerKeyframes();
  }, [shimmer]);

  const settled = running && !shimmer;
  return (
    <Text style={[styles.text, shimmer && styles.shimmer]} numberOfLines={1}>
      <Text style={styles.verb}>{verb}</Text>
      {target ? (
        <Text
          style={[
            styles.target,
            targetMono && styles.targetMono,
            (emphasized || settled) && styles.targetEmphasized,
          ]}
        >
          {` ${target}`}
        </Text>
      ) : null}
    </Text>
  );
});

const styles = StyleSheet.create((theme) => ({
  text: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
  },
  verb: {
    color: theme.colors.foreground,
  },
  target: {
    color: theme.colors.foregroundMuted,
  },
  targetMono: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
  },
  targetEmphasized: {
    color: theme.colors.foreground,
  },
  // Web-only CSS: the gradient is clipped to the glyphs and the fill made transparent, so the
  // spans' own colors give way to it.
  shimmer: {
    ...({
      backgroundImage: `linear-gradient(90deg, ${theme.colors.foregroundMuted} 0%, ${theme.colors.foregroundMuted} 38%, ${theme.colors.foreground} 50%, ${theme.colors.foregroundMuted} 62%, ${theme.colors.foregroundMuted} 100%)`,
      backgroundSize: "260% 100%",
      backgroundRepeat: "no-repeat",
      backgroundClip: "text",
      WebkitBackgroundClip: "text",
      WebkitTextFillColor: "transparent",
      color: "transparent",
      animation: `${ANIMATION_NAME} 1.9s linear infinite`,
    } as object),
  },
}));
