import type { RefObject } from "react";
import type { View } from "react-native";

/** Wheel events reach the timeline on web only; native scrolls nested views by touch. */
export function useDetailWheelBlocker(_input: {
  detailRef: RefObject<View | null>;
  enabled: boolean;
}): void {}
