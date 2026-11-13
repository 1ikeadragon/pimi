import MaskedView from "@react-native-masked-view/masked-view";
import { memo, useCallback, useEffect, useId, useMemo, useState } from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, { Defs, Rect, Stop, LinearGradient as SvgLinearGradient } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import type { ActivityTextProps } from "./activity-text.types";

const SHIMMER_SECONDS = 1.6;

function Label({
  verb,
  target,
  targetMono = false,
  emphasized,
  running,
  shimmering,
  maskColor,
}: Pick<ActivityTextProps, "verb" | "target" | "targetMono" | "emphasized" | "running"> & {
  shimmering: boolean;
  maskColor?: string;
}) {
  // Shimmering, the whole label rests at muted and the band brings it to foreground.
  const settled = running && !shimmering;
  const maskStyle = maskColor ? { color: maskColor } : undefined;
  return (
    <Text style={[styles.text, maskStyle]} numberOfLines={1}>
      <Text style={[styles.verb, shimmering && styles.target, maskStyle]}>{verb}</Text>
      {target ? (
        <Text
          style={[
            styles.target,
            targetMono && styles.targetMono,
            !shimmering && (emphasized || settled) && styles.targetEmphasized,
            maskStyle,
          ]}
        >
          {` ${target}`}
        </Text>
      ) : null}
    </Text>
  );
}

function PeakSvg({ color, gradientId }: { color?: string; gradientId: string }) {
  return (
    <Svg width="100%" height="100%" preserveAspectRatio="none">
      <Defs>
        <SvgLinearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
          <Stop offset="0%" stopColor={color} stopOpacity={0} />
          <Stop offset="50%" stopColor={color} stopOpacity={1} />
          <Stop offset="100%" stopColor={color} stopOpacity={0} />
        </SvgLinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${gradientId})`} />
    </Svg>
  );
}

const ThemedPeakSvg = withUnistyles(PeakSvg, (theme: Theme) => ({
  color: theme.colors.foreground,
}));

function ShimmerOverlay({
  width,
  height,
  labelProps,
}: {
  width: number;
  height: number;
  labelProps: Pick<ActivityTextProps, "verb" | "target" | "targetMono" | "emphasized" | "running">;
}) {
  const gradientId = useId();
  const translateX = useSharedValue(0);
  const peakWidth = Math.max(32, Math.min(120, width * 0.3));

  useEffect(() => {
    translateX.value = -peakWidth;
    translateX.value = withRepeat(
      withTiming(width + peakWidth, { duration: SHIMMER_SECONDS * 1000, easing: Easing.linear }),
      -1,
      false,
    );
    return () => cancelAnimation(translateX);
  }, [peakWidth, translateX, width]);

  const peakStyle = useAnimatedStyle(() => ({ transform: [{ translateX: translateX.value }] }));
  const trackStyle = useMemo(() => ({ width, height }), [height, width]);
  const maskStyle = useMemo(
    () => ({ width, height, justifyContent: "center" as const }),
    [height, width],
  );
  const peakSize = useMemo(() => ({ width: peakWidth, height }), [height, peakWidth]);
  const maskElement = useMemo(
    () => (
      <View pointerEvents="none" style={maskStyle}>
        <Label {...labelProps} shimmering maskColor="#000000" />
      </View>
    ),
    [labelProps, maskStyle],
  );

  return (
    <View style={styles.overlay} pointerEvents="none">
      <MaskedView pointerEvents="none" style={trackStyle} maskElement={maskElement}>
        <Animated.View style={[styles.peak, peakStyle, peakSize]}>
          <ThemedPeakSvg gradientId={gradientId} />
        </Animated.View>
      </MaskedView>
    </View>
  );
}

/**
 * Verb and target in one text. While running, a foreground-colored band sweeps across it through a
 * mask of the same text, drawn over the muted label.
 */
export const ActivityText = memo(function ActivityText({
  verb,
  target,
  targetMono,
  emphasized,
  running,
  shimmer,
}: ActivityTextProps) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((previous) =>
      Math.abs(previous.width - width) > 0.5 || Math.abs(previous.height - height) > 0.5
        ? { width, height }
        : previous,
    );
  }, []);
  const labelProps = useMemo(
    () => ({ verb, target, targetMono, emphasized, running }),
    [emphasized, running, target, targetMono, verb],
  );
  const shimmering = shimmer && size.width > 0;

  return (
    <View style={styles.wrap} onLayout={handleLayout}>
      <Label {...labelProps} shimmering={shimmering} />
      {shimmering ? (
        <ShimmerOverlay width={size.width} height={size.height} labelProps={labelProps} />
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  wrap: {
    flexShrink: 1,
    minWidth: 0,
  },
  text: {
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
  overlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    overflow: "hidden",
  },
  peak: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
  },
}));
