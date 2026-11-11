import { useEffect, useState, type RefObject } from "react";
import type { View, ViewStyle } from "react-native";

/**
 * Flow motion on web: dashed edges march toward their heads, and dimming fades. Both are CSS on
 * the SVG elements, so the browser runs them without React. With reduced motion the rules are
 * never defined, so edges stand still and dimming is instant.
 */
const MARCH_ANIMATION = "pimi-flow-march";
export const FLOW_MARCH_CLASS = "pimi-flow-marching";
export const FLOW_FADE_CLASS = "pimi-flow-fade";

function ensureFlowMotionStyles() {
  if (typeof document === "undefined" || document.getElementById(MARCH_ANIMATION)) return;
  const style = document.createElement("style");
  style.id = MARCH_ANIMATION;
  // 20px is a whole number of periods of both dash patterns (6 4 and 2 3), so the loop is seamless.
  style.textContent = `@media (prefers-reduced-motion: no-preference) {
  @keyframes ${MARCH_ANIMATION} { to { stroke-dashoffset: -20px; } }
  .${FLOW_MARCH_CLASS} { animation: ${MARCH_ANIMATION} 3s linear infinite; }
  .${FLOW_FADE_CLASS} { transition: opacity 180ms ease-out; }
}`;
  document.head.appendChild(style);
}
ensureFlowMotionStyles();

// A view cannot take a class, so the icon views fade by inline style, with the same reduced-motion
// rule. The CSS transition props are not part of ViewStyle without the generated expo-env.d.ts.
const reducedMotion =
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
export const FLOW_FADE_STYLE = (reducedMotion
  ? {}
  : { transitionProperty: "opacity", transitionDuration: "180ms" }) as unknown as ViewStyle;

/**
 * True while the element is on screen. A chat can hold many flows; only the ones in view march,
 * and a flow in a hidden panel or scrolled away costs nothing.
 */
export function useFlowOnScreen(element: RefObject<View | null>): boolean {
  const [onScreen, setOnScreen] = useState(false);
  useEffect(() => {
    const node = element.current as unknown as Element | null;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) setOnScreen(last.isIntersecting);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [element]);
  return onScreen;
}
