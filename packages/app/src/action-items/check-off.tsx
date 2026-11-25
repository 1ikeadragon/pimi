import * as Haptics from "expo-haptics";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import type { ActionItem } from "@pimi/protocol/action-items/types";
import { isNative, isWeb } from "@/constants/platform";
import { CHECK_POP_START_SCALE, motionCss, motionDuration, motionEasing } from "@/styles/motion";

/**
 * The check-off of an action item: it is done, so it stays in Open long enough to be seen
 * finishing, then leaves for Done.
 *
 * `marking`: the mark pops to a check and the text strikes and fades to muted, over
 * `motionDuration.toggle`, then the row dwells. `collapsing`: the row's height and opacity close
 * over `motionDuration.toastExit`. After that the item is no longer closing and the list shows
 * it under Done, with no enter animation.
 *
 * Web animates through the Web Animations API, like `Enter` (enter.tsx), to avoid the Reanimated
 * web keyframe gotcha it describes. Native uses Reanimated shared values.
 */
export type ClosingPhase = "marking" | "collapsing";
export type ClosingItems = ReadonlyMap<string, ClosingPhase>;

const NOT_CLOSING: ClosingItems = new Map();

function useReducedMotionPreference(): boolean {
  const system = useReducedMotion();
  if (isWeb && typeof window !== "undefined") {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }
  return system;
}

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

interface OpenIds {
  agentId: string;
  ids: ReadonlySet<string>;
}

/**
 * Which items are closing, from the difference between this list and the last one rendered: an
 * item that was open and is now done starts closing. An item seen done for the first time (a chat
 * just opened, a list that just loaded) does not, so only a check made while the list is on
 * screen animates. Reduced motion skips the dwell and the collapse: the item regroups as soon as
 * its text has faded.
 */
export function useCheckOff(agentId: string, items: readonly ActionItem[]): ClosingItems {
  const reduced = useReducedMotionPreference();
  const [previous, setPrevious] = useState<OpenIds | null>(null);
  const [closing, setClosing] = useState<ClosingItems>(NOT_CLOSING);

  // Derived during render, not in an effect, so a newly done item never shows once under Done
  // before it is moved back to Open to animate.
  const openIds = new Set(items.filter((item) => !item.done).map((item) => item.id));
  if (!previous || previous.agentId !== agentId) {
    setPrevious({ agentId, ids: openIds });
    setClosing(NOT_CLOSING);
  } else {
    const byId = new Map(items.map((item) => [item.id, item]));
    const next = new Map(closing);
    for (const id of closing.keys()) {
      // Unchecked again, or deleted, while closing: it is an ordinary row again.
      if (!byId.get(id)?.done) next.delete(id);
    }
    for (const id of previous.ids) {
      if (byId.get(id)?.done && !next.has(id)) next.set(id, "marking");
    }
    const changed =
      next.size !== closing.size || [...next].some(([id, phase]) => closing.get(id) !== phase);
    if (changed) setClosing(next);
    if (!sameIds(previous.ids, openIds)) setPrevious({ agentId, ids: openIds });
  }

  const timers = useRef(
    new Map<string, { phase: ClosingPhase; handle: ReturnType<typeof setTimeout> }>(),
  );
  useEffect(() => {
    const scheduled = timers.current;
    for (const [id, timer] of scheduled) {
      if (closing.get(id) !== timer.phase) {
        clearTimeout(timer.handle);
        scheduled.delete(id);
      }
    }
    for (const [id, phase] of closing) {
      if (scheduled.has(id)) continue;
      const delay =
        phase === "marking"
          ? motionDuration.toggle + (reduced ? 0 : motionDuration.checkOffDwell)
          : motionDuration.toastExit;
      const handle = setTimeout(() => {
        scheduled.delete(id);
        setClosing((current) => {
          if (current.get(id) !== phase) return current;
          const next = new Map(current);
          if (phase === "marking" && !reduced) next.set(id, "collapsing");
          else next.delete(id);
          return next;
        });
      }, delay);
      scheduled.set(id, { phase, handle });
    }
  }, [closing, reduced]);
  useEffect(() => {
    const scheduled = timers.current;
    return () => {
      for (const timer of scheduled.values()) clearTimeout(timer.handle);
      scheduled.clear();
    };
  }, []);

  // One selection haptic per check, however many items close in the same update.
  const announced = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!isNative) return;
    const fresh = [...closing.keys()].some((id) => !announced.current.has(id));
    announced.current = new Set(closing.keys());
    if (!fresh) return;
    Haptics.selectionAsync().catch((error: unknown) => {
      console.warn("[action-items] check-off haptic failed", error);
    });
  }, [closing]);

  return closing;
}

// Plays `keyframes` on the element with this `nativeID` each time `active` becomes true. `fill`
// keeps the last frame: a fade-out must not snap back to opaque when it ends.
function useWebAnimation(
  nativeID: string,
  active: boolean,
  build: (element: HTMLElement) => PropertyIndexedKeyframes,
  options: { duration: number; fill: FillMode },
): void {
  useLayoutEffect(() => {
    if (!isWeb || !active || typeof document === "undefined") return undefined;
    const element = document.getElementById(nativeID);
    if (!element) return undefined;
    const animation = element.animate(build(element), {
      duration: options.duration,
      easing: motionCss.out,
      fill: options.fill,
    });
    return () => animation.cancel();
    // `build` and `options` are constants at each call site; only `active` starts a play.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}

const POP_TIMING = { duration: motionDuration.toggle, fill: "none" } as const;
const FADE_TIMING = { duration: motionDuration.toggle, fill: "forwards" } as const;
const COLLAPSE_TIMING = { duration: motionDuration.toastExit, fill: "forwards" } as const;

const popKeyframes = (): PropertyIndexedKeyframes => ({
  transform: [`scale(${CHECK_POP_START_SCALE})`, "scale(1)"],
});
const fadeOutKeyframes = (): PropertyIndexedKeyframes => ({ opacity: [1, 0] });
const collapseKeyframes = (element: HTMLElement): PropertyIndexedKeyframes => ({
  height: [`${element.offsetHeight}px`, "0px"],
  opacity: [1, 0],
  overflow: ["hidden", "hidden"],
});

/** Pops its child from `CHECK_POP_START_SCALE` to full size when `active` turns on. */
export function CheckPop({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}): ReactElement {
  const reduced = useReducedMotionPreference();
  const play = active && !reduced;
  if (isWeb) return <WebPop play={play}>{children}</WebPop>;
  return <NativePop play={play}>{children}</NativePop>;
}

function WebPop({ play, children }: { play: boolean; children: ReactNode }): ReactElement {
  const nativeID = useId();
  useWebAnimation(nativeID, play, popKeyframes, POP_TIMING);
  return <View nativeID={nativeID}>{children}</View>;
}

function NativePop({ play, children }: { play: boolean; children: ReactNode }): ReactElement {
  const scale = useSharedValue(1);
  useEffect(() => {
    if (!play) return;
    scale.value = CHECK_POP_START_SCALE;
    scale.value = withTiming(1, { duration: motionDuration.toggle, easing: motionEasing.out });
  }, [play, scale]);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return <Animated.View style={style}>{children}</Animated.View>;
}

/**
 * Fades its child from fully visible to gone when `active` turns on. The child is the text in its
 * old foreground colour, laid over the same text in the muted colour, so the colour changes by
 * crossfade: the animated node is a plain View, not a Unistyles-styled Text.
 */
export function CheckFade({
  active,
  style,
  children,
}: {
  active: boolean;
  style: StyleProp<ViewStyle>;
  children: ReactNode;
}): ReactElement {
  if (isWeb) {
    return (
      <WebFade active={active} style={style}>
        {children}
      </WebFade>
    );
  }
  return (
    <NativeFade active={active} style={style}>
      {children}
    </NativeFade>
  );
}

function WebFade({
  active,
  style,
  children,
}: {
  active: boolean;
  style: StyleProp<ViewStyle>;
  children: ReactNode;
}): ReactElement {
  const nativeID = useId();
  useWebAnimation(nativeID, active, fadeOutKeyframes, FADE_TIMING);
  return (
    <View nativeID={nativeID} style={style} pointerEvents="none">
      {children}
    </View>
  );
}

function NativeFade({
  active,
  style,
  children,
}: {
  active: boolean;
  style: StyleProp<ViewStyle>;
  children: ReactNode;
}): ReactElement {
  const opacity = useSharedValue(1);
  useEffect(() => {
    if (!active) return;
    opacity.value = withTiming(0, { duration: motionDuration.toggle, easing: motionEasing.out });
  }, [active, opacity]);
  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View style={[style, animatedStyle]} pointerEvents="none">
      {children}
    </Animated.View>
  );
}

/** Closes its child's height and opacity over `motionDuration.toastExit` when `active` turns on. */
export function CheckCollapse({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}): ReactElement {
  if (isWeb) return <WebCollapse active={active}>{children}</WebCollapse>;
  return <NativeCollapse active={active}>{children}</NativeCollapse>;
}

function WebCollapse({ active, children }: { active: boolean; children: ReactNode }): ReactElement {
  const nativeID = useId();
  useWebAnimation(nativeID, active, collapseKeyframes, COLLAPSE_TIMING);
  return <View nativeID={nativeID}>{children}</View>;
}

function NativeCollapse({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}): ReactElement {
  // Height cannot animate from `auto`, so the row's own height is measured while it is at rest.
  const height = useSharedValue(0);
  const progress = useSharedValue(0);
  useEffect(() => {
    if (!active) return;
    progress.value = withTiming(1, {
      duration: motionDuration.toastExit,
      easing: motionEasing.out,
    });
  }, [active, progress]);
  const style = useAnimatedStyle(() =>
    progress.value === 0
      ? {}
      : {
          height: height.value * (1 - progress.value),
          opacity: 1 - progress.value,
          overflow: "hidden",
        },
  );
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      if (progress.value === 0) height.value = event.nativeEvent.layout.height;
    },
    [height, progress],
  );
  return (
    <Animated.View style={style} onLayout={handleLayout}>
      {children}
    </Animated.View>
  );
}
