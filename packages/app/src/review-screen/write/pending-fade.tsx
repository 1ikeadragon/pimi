// Pimi. PolyForm-Noncommercial-1.0.0.
// A comment the user just posted fades in (opacity only, no translate, no height change) while it
// is still being sent. The real row that replaces it is a plain row: no second animation.
import type { ReactNode } from "react";
import Animated, { FadeIn } from "react-native-reanimated";
import { motionDuration, motionEasing } from "@/styles/motion";

const ENTERING = FadeIn.duration(motionDuration.popoverEnter).easing(motionEasing.out);

export function PendingFade({
  pending,
  children,
}: {
  pending: boolean;
  children: ReactNode;
}): ReactNode {
  if (!pending) return children;
  return <Animated.View entering={ENTERING}>{children}</Animated.View>;
}
