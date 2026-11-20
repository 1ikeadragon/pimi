import {
  forwardRef,
  useLayoutEffect,
  useMemo,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  ScrollView,
  StyleSheet,
  type ScrollViewProps,
  type StyleProp,
  type View,
  type ViewStyle,
} from "react-native";
import Animated from "react-native-reanimated";
import { isWeb } from "@/constants/platform";
import { motionCss, SURFACE_ENTER_SCALE } from "@/styles/motion";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";

export interface FloatingSurfaceProps extends Omit<ComponentProps<typeof Animated.View>, "style"> {
  frameStyle?: StyleProp<ViewStyle>;
  style?: StyleProp<ViewStyle>;
}

export const FloatingSurface = forwardRef<View, FloatingSurfaceProps>(function FloatingSurface(
  { frameStyle, style, ...props },
  ref,
): ReactElement {
  const inlineFrameStyle = useMemo(() => {
    const flattened = StyleSheet.flatten(frameStyle);
    return flattened ? inlineUnistylesStyle(stripUnistylesMetadata(flattened)) : undefined;
  }, [frameStyle]);
  const surfaceStyle = useMemo(
    () => appendStyle(style, inlineFrameStyle),
    [inlineFrameStyle, style],
  );
  return <Animated.View {...props} ref={ref} style={surfaceStyle} />;
});

const WEB_SURFACE_ENTERING_KEYFRAMES: PropertyIndexedKeyframes = {
  opacity: [0, 1],
  transform: [`scale(${SURFACE_ENTER_SCALE})`, "scale(1)"],
};
/** Reduced motion keeps the fade and drops the scale. */
const WEB_REDUCED_SURFACE_ENTERING_KEYFRAMES: PropertyIndexedKeyframes = { opacity: [0, 1] };

/**
 * Plays a floating surface's enter on web, scaling from its `transformOrigin`, once the surface
 * is placed. Before placement it sits off-screen being measured, where an enter would be wasted.
 *
 * Web uses the Web Animations API rather than a Reanimated keyframe. Reanimated's web path
 * snapshots an element's rect when a custom keyframe ends and, when it cleans the keyframe up
 * 750ms after the start, writes that rect back as inline top/left/width/height. A surface that
 * moved or resized in between — content that grew once its data arrived — snapped back to the old
 * rect and stayed there, clipped or hanging past its anchor. A Web Animation leaves no inline style.
 */
export function useWebSurfaceEntering({
  placed,
  surfaceNativeID,
  durationMs,
}: {
  placed: boolean;
  surfaceNativeID: string;
  /** 0 shows the surface at once, as when a neighbouring tooltip just handed over. */
  durationMs: number;
}): void {
  useLayoutEffect(() => {
    if (!isWeb || !placed || durationMs <= 0 || typeof document === "undefined") return undefined;
    const keyframes = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? WEB_REDUCED_SURFACE_ENTERING_KEYFRAMES
      : WEB_SURFACE_ENTERING_KEYFRAMES;
    const animation = document
      .getElementById(surfaceNativeID)
      ?.animate(keyframes, { duration: durationMs, easing: motionCss.out });
    return () => animation?.cancel();
  }, [placed, surfaceNativeID, durationMs]);
}

export interface FloatingScrollViewProps {
  bounces?: boolean;
  children: ReactNode;
  contentContainerStyle?: StyleProp<ViewStyle>;
  keyboardShouldPersistTaps?: ScrollViewProps["keyboardShouldPersistTaps"];
  showsVerticalScrollIndicator?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function FloatingScrollView({
  bounces,
  children,
  contentContainerStyle,
  keyboardShouldPersistTaps,
  showsVerticalScrollIndicator,
  style,
}: FloatingScrollViewProps): ReactElement {
  const inlineStyle = useMemo(() => {
    const flattened = StyleSheet.flatten(style);
    return flattened ? inlineUnistylesStyle(stripUnistylesMetadata(flattened)) : undefined;
  }, [style]);

  return (
    <ScrollView
      bounces={bounces}
      contentContainerStyle={contentContainerStyle}
      keyboardShouldPersistTaps={keyboardShouldPersistTaps}
      showsVerticalScrollIndicator={showsVerticalScrollIndicator}
      style={inlineStyle}
    >
      {children}
    </ScrollView>
  );
}

function appendStyle(
  style: StyleProp<ViewStyle>,
  extraStyle: ViewStyle | undefined,
): StyleProp<ViewStyle> {
  if (!extraStyle) {
    return style;
  }
  if (Array.isArray(style)) {
    return [...style, extraStyle];
  }
  return [style, extraStyle];
}

function stripUnistylesMetadata(style: ViewStyle): ViewStyle {
  const cleanStyle: Record<string, unknown> = { ...style };
  for (const key of Object.keys(cleanStyle)) {
    if (key.startsWith("unistyles_")) {
      delete cleanStyle[key];
    }
  }
  return cleanStyle as ViewStyle;
}
