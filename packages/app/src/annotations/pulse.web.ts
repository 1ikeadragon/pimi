// Adapted from T3 Code apps/web/src/components/chat/AssistantCitationSource.tsx (MIT, © 2026 T3 Tools Inc.).
import { ANNOTATION_PULSE_OPACITY } from "./popover.web";

const PULSE_DURATION_MS = 650;
const HOLD_MS = 1575;
const FADE_MS = 450;
export const ANNOTATION_PULSE_TOTAL_MS = 1.5 * PULSE_DURATION_MS + HOLD_MS + FADE_MS;
const PEAK_OPACITY = 0.45;
/** Where an annotation's source lands below the top of its surface, at most a third of the way down. */
export const ANNOTATION_SOURCE_TOP_OFFSET_PX = 120;

/** Two pulses, a hold and a fade; reduced motion holds and fades. Animate on an ancestor of the text. */
export function annotationPulseKeyframes(reducedMotion: boolean): Keyframe[] {
  const at = (milliseconds: number) => milliseconds / ANNOTATION_PULSE_TOTAL_MS;
  const holdEnd = at(ANNOTATION_PULSE_TOTAL_MS - FADE_MS);
  if (reducedMotion) {
    return [
      { offset: 0, [ANNOTATION_PULSE_OPACITY]: PEAK_OPACITY },
      { offset: holdEnd, [ANNOTATION_PULSE_OPACITY]: PEAK_OPACITY },
      { offset: 1, [ANNOTATION_PULSE_OPACITY]: 0 },
    ];
  }
  return [
    { offset: 0, [ANNOTATION_PULSE_OPACITY]: 0 },
    { offset: at(PULSE_DURATION_MS * 0.5), [ANNOTATION_PULSE_OPACITY]: PEAK_OPACITY },
    { offset: at(PULSE_DURATION_MS), [ANNOTATION_PULSE_OPACITY]: 0 },
    { offset: at(PULSE_DURATION_MS * 1.5), [ANNOTATION_PULSE_OPACITY]: PEAK_OPACITY },
    { offset: holdEnd, [ANNOTATION_PULSE_OPACITY]: PEAK_OPACITY },
    { offset: 1, [ANNOTATION_PULSE_OPACITY]: 0 },
  ];
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
