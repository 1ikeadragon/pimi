import { useEffect, useMemo } from "react";
import { View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useRetainedPanelActive } from "@/components/retained-panel";
import {
  PIMI_GLYPH_LEFT_EAR_PIVOT,
  PIMI_GLYPH_RIGHT_EAR_PIVOT,
  PimiGlyphHead,
  PimiGlyphLeftEar,
  PimiGlyphRightEar,
} from "@/components/icons/pimi-glyph";

const LOOP_MS = 1400;
const EAR_SWING_DEG = 14;
const WAITING_TILT_DEG = 12;
const VIEWBOX_UNITS = 24;

// Ear swing as a share of the loop: out and back, the right ear starting a beat after the
// left, then both rest for the remaining ~70%.
const LEFT_EAR_WINDOW = { start: 0, end: 0.18 } as const;
const RIGHT_EAR_WINDOW = { start: 0.12, end: 0.3 } as const;

function earAngle(phase: number, window: { start: number; end: number }, sign: 1 | -1): number {
  "worklet";
  if (phase < window.start || phase > window.end) {
    return 0;
  }
  const progress = (phase - window.start) / (window.end - window.start);
  return sign * EAR_SWING_DEG * Math.sin(Math.PI * progress);
}

export function WorkingPimi({
  size = 18,
  color,
  waiting = false,
}: {
  size?: number;
  color: string;
  /** Asking for input: a static head tilt instead of the ear loop. */
  waiting?: boolean;
}) {
  const active = useRetainedPanelActive();
  const reduceMotion = useReducedMotion();
  const animate = active && !reduceMotion && !waiting;
  const phase = useSharedValue(0);

  useEffect(() => {
    if (!animate) {
      cancelAnimation(phase);
      phase.value = 0;
      return;
    }
    phase.value = 0;
    phase.value = withRepeat(withTiming(1, { duration: LOOP_MS, easing: Easing.linear }), -1);
    return () => cancelAnimation(phase);
  }, [animate, phase]);

  const unit = size / VIEWBOX_UNITS;
  const leftOrigin = `${PIMI_GLYPH_LEFT_EAR_PIVOT.x * unit}px ${PIMI_GLYPH_LEFT_EAR_PIVOT.y * unit}px`;
  const rightOrigin = `${PIMI_GLYPH_RIGHT_EAR_PIVOT.x * unit}px ${PIMI_GLYPH_RIGHT_EAR_PIVOT.y * unit}px`;

  const leftStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${earAngle(phase.value, LEFT_EAR_WINDOW, -1)}deg` }],
    transformOrigin: leftOrigin,
  }));
  const rightStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${earAngle(phase.value, RIGHT_EAR_WINDOW, 1)}deg` }],
    transformOrigin: rightOrigin,
  }));

  const frameStyle = useMemo(
    () => ({
      width: size,
      height: size,
      transform: [{ rotate: waiting ? `${WAITING_TILT_DEG}deg` : "0deg" }],
    }),
    [size, waiting],
  );
  const layerStyle = useMemo(
    () => ({ position: "absolute" as const, left: 0, top: 0, width: size, height: size }),
    [size],
  );
  const leftLayerStyle = useMemo(() => [layerStyle, leftStyle], [layerStyle, leftStyle]);
  const rightLayerStyle = useMemo(() => [layerStyle, rightStyle], [layerStyle, rightStyle]);

  return (
    <View style={frameStyle}>
      <Animated.View style={leftLayerStyle}>
        <PimiGlyphLeftEar size={size} color={color} />
      </Animated.View>
      <Animated.View style={rightLayerStyle}>
        <PimiGlyphRightEar size={size} color={color} />
      </Animated.View>
      <View style={layerStyle}>
        <PimiGlyphHead size={size} color={color} />
      </View>
    </View>
  );
}
