import { useEffect } from "react";
import { View } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { Sword, Swords } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";

const SIZE = 28;
const SLIDE_MS = 260;
const SPARK_MS = 360;
const SLIDE_DISTANCE = 13;
const SLIDE_TILT_DEG = 40;
const EASE_OUT = Easing.out(Easing.cubic);

const accentIcon = (theme: Theme) => ({
  color: theme.colors.accent,
  size: theme.iconSize.lg,
});
const AccentSword = withUnistyles(Sword, accentIcon);
const AccentSwords = withUnistyles(Swords, accentIcon);

/**
 * The crossed-swords mark beside the Attack mode switch. Dim while off. Turning it on slides two
 * single blades in from either side; as they meet they hand over to the crossed-swords glyph, a
 * small spark flashes, the mark gives one slight pulse and settles lit. Reduce motion jumps straight to the end state.
 */
export function AttackClash({ active }: { active: boolean }) {
  const reduceMotion = useReducedMotion();
  const lit = useSharedValue(active ? 1 : 0);
  const slide = useSharedValue(1);
  const spark = useSharedValue(0);
  const pulse = useSharedValue(1);

  useEffect(() => {
    cancelAnimation(lit);
    cancelAnimation(slide);
    cancelAnimation(spark);
    cancelAnimation(pulse);
    spark.value = 0;
    pulse.value = 1;
    if (!active || reduceMotion) {
      lit.value = withTiming(active ? 1 : 0, { duration: reduceMotion ? 0 : 160 });
      slide.value = 1;
      return;
    }
    slide.value = 0;
    lit.value = withTiming(1, { duration: SLIDE_MS });
    slide.value = withTiming(1, { duration: SLIDE_MS, easing: EASE_OUT });
    spark.value = withDelay(SLIDE_MS - 20, withTiming(1, { duration: SPARK_MS, easing: EASE_OUT }));
    pulse.value = withDelay(
      SLIDE_MS - 20,
      withSequence(
        withTiming(1.14, { duration: 90, easing: EASE_OUT }),
        withTiming(1, { duration: 220, easing: Easing.inOut(Easing.ease) }),
      ),
    );
  }, [active, reduceMotion, lit, slide, spark, pulse]);

  const markStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulse.value }],
  }));
  // The single blades hand over to the crossed glyph over the last fifth of the slide.
  const settledStyle = useAnimatedStyle(() => ({
    opacity: (0.3 + 0.7 * lit.value) * Math.min(1, Math.max(0, (slide.value - 0.8) / 0.2)),
  }));
  const leftStyle = useAnimatedStyle(() => ({
    opacity:
      Math.min(1, slide.value * 4) * (1 - Math.min(1, Math.max(0, (slide.value - 0.8) / 0.2))),
    transform: [
      { translateX: -SLIDE_DISTANCE * (1 - slide.value) },
      { rotate: `${-SLIDE_TILT_DEG * (1 - slide.value)}deg` },
    ],
  }));
  const rightStyle = useAnimatedStyle(() => ({
    opacity:
      Math.min(1, slide.value * 4) * (1 - Math.min(1, Math.max(0, (slide.value - 0.8) / 0.2))),
    transform: [
      { translateX: SLIDE_DISTANCE * (1 - slide.value) },
      { rotate: `${SLIDE_TILT_DEG * (1 - slide.value)}deg` },
      { scaleX: -1 },
    ],
  }));
  const ringStyle = useAnimatedStyle(() => ({
    opacity: spark.value === 0 ? 0 : 0.7 * (1 - spark.value),
    transform: [{ scale: 0.3 + 1.1 * spark.value }],
  }));
  const glintStyle = useAnimatedStyle(() => ({
    opacity: spark.value === 0 ? 0 : 1 - Math.min(1, spark.value * 2.2),
    transform: [{ scale: 0.6 + 1.4 * Math.min(1, spark.value * 2.2) }],
  }));

  return (
    <View style={styles.box} pointerEvents="none">
      <Animated.View style={[styles.layer, markStyle]}>
        <Animated.View style={[styles.layer, settledStyle]}>
          <AccentSwords />
        </Animated.View>
        <Animated.View style={[styles.layer, leftStyle]}>
          <AccentSword />
        </Animated.View>
        <Animated.View style={[styles.layer, rightStyle]}>
          <AccentSword />
        </Animated.View>
      </Animated.View>
      <Animated.View style={[styles.ring, ringStyle]} />
      <Animated.View style={[styles.glint, glintStyle]} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  box: { width: SIZE, height: SIZE, alignItems: "center", justifyContent: "center" },
  layer: {
    position: "absolute",
    width: SIZE,
    height: SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  ring: {
    position: "absolute",
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    borderWidth: 1.5,
    borderColor: theme.colors.accent,
    opacity: 0,
  },
  glint: {
    position: "absolute",
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.accent,
    opacity: 0,
  },
}));
