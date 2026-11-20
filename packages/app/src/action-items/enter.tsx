import { useId, useLayoutEffect, type ReactElement, type ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import Animated, { FadeIn, Keyframe } from "react-native-reanimated";
import { isWeb } from "@/constants/platform";
import { SURFACE_ENTER_SCALE, motionCss, motionDuration, motionEasing } from "@/styles/motion";

type EnterKind = "card" | "item";

const DURATION: Record<EnterKind, number> = {
  // The note arriving is rare and watched; a row arriving happens once a turn at most.
  card: motionDuration.toastEnter,
  item: motionDuration.toggle,
};

const WEB_KEYFRAMES: Record<EnterKind, PropertyIndexedKeyframes> = {
  card: {
    opacity: [0, 1],
    transform: [`translateX(12px) scale(${SURFACE_ENTER_SCALE})`, "translateX(0) scale(1)"],
  },
  item: { opacity: [0, 1], transform: ["translateY(4px)", "translateY(0)"] },
};
const WEB_REDUCED_KEYFRAMES: PropertyIndexedKeyframes = { opacity: [0, 1] };

// Native layout animations follow the system reduce-motion setting on their own.
const NATIVE_ENTERING = {
  card: new Keyframe({
    0: { opacity: 0, transform: [{ translateX: 12 }, { scale: SURFACE_ENTER_SCALE }] },
    100: {
      opacity: 1,
      transform: [{ translateX: 0 }, { scale: 1 }],
      easing: motionEasing.out,
    },
  }).duration(DURATION.card),
  item: FadeIn.duration(DURATION.item).easing(motionEasing.out),
};

/**
 * Plays a one-shot enter when it mounts with `animate`. Web uses the Web Animations API for the
 * reason given at `useWebSurfaceEntering`: a Reanimated web keyframe writes the element's old
 * rect back as inline styles, which pins a row that reflowed. The wrapper carries no Unistyles
 * style, so the animated node stays plain.
 */
export function Enter({
  kind,
  animate,
  style,
  children,
}: {
  kind: EnterKind;
  animate: boolean;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}): ReactElement {
  const nativeID = useId();
  useLayoutEffect(() => {
    if (!isWeb || !animate || typeof document === "undefined") return undefined;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const animation = document
      .getElementById(nativeID)
      ?.animate(reduced ? WEB_REDUCED_KEYFRAMES : WEB_KEYFRAMES[kind], {
        duration: DURATION[kind],
        easing: motionCss.out,
      });
    return () => animation?.cancel();
    // One shot at mount; later prop changes must not replay it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (isWeb) {
    return (
      <View nativeID={nativeID} style={style}>
        {children}
      </View>
    );
  }
  return (
    <Animated.View entering={animate ? NATIVE_ENTERING[kind] : undefined} style={style}>
      {children}
    </Animated.View>
  );
}
