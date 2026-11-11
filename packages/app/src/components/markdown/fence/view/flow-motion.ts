import type { RefObject } from "react";
import type { View, ViewStyle } from "react-native";

/**
 * Native flows do not march. A native chat list gives a block no cheap way to know it scrolled
 * away, and a UI-thread loop per flow would keep running off screen. Edges stay dashed and still,
 * and dimming is instant.
 */
export const FLOW_MARCH_CLASS: string | undefined = undefined;
export const FLOW_FADE_CLASS: string | undefined = undefined;
export const FLOW_FADE_STYLE: ViewStyle = {};

export function useFlowOnScreen(_element: RefObject<View | null>): boolean {
  return false;
}
