import { useEffect, useMemo } from "react";
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
import { PimiMascot } from "@/components/icons/pimi-mascot";

const LOOP_MS = 1400;
const WIGGLE_DEG = 10;
const WAITING_TILT_DEG = 12;
// The wiggle takes the first 30% of the loop (a left-right head shake), then rests.
const WIGGLE_SHARE = 0.3;

function wiggleAngle(phase: number): number {
  "worklet";
  if (phase > WIGGLE_SHARE) {
    return 0;
  }
  return WIGGLE_DEG * Math.sin((2 * Math.PI * phase) / WIGGLE_SHARE);
}

// The Ask Pimi mascot, shaking its head while an agent works and tilted while it waits for you.
export function WorkingPimi({
  size = 18,
  waiting = false,
}: {
  size?: number;
  /** Asking for input: a static head tilt instead of the wiggle loop. */
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

  const wiggleStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${wiggleAngle(phase.value)}deg` }],
  }));
  const frameStyle = useMemo(
    () => ({
      width: size,
      height: size,
      transform: [{ rotate: waiting ? `${WAITING_TILT_DEG}deg` : "0deg" }],
    }),
    [size, waiting],
  );
  const style = useMemo(() => [frameStyle, wiggleStyle], [frameStyle, wiggleStyle]);

  return (
    <Animated.View style={style}>
      <PimiMascot size={size} />
    </Animated.View>
  );
}
