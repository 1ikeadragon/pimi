import { Easing } from "react-native-reanimated";

/**
 * Motion tokens. One curve for the whole app, `out`, for anything entering, leaving, or answering a
 * press. Never use the built-in ease-in/ease-out curves, and never ease-in on UI: it delays the
 * frame the user watches.
 *
 * What does not animate at all: keyboard-driven actions, tab switches, scrolling, list navigation,
 * and anything in the chat timeline. See docs/design.md#12-motion.
 */
export const motionCss = {
  out: "cubic-bezier(0.23, 1, 0.32, 1)",
} as const;

/** The same curve for Reanimated (`withTiming`, `Keyframe`, layout animations). */
export const motionEasing = {
  out: Easing.bezier(0.23, 1, 0.32, 1),
} as const;

/** Milliseconds. Exits run faster than their enter: the user is already done with the surface. */
export const motionDuration = {
  /** Press scale and hover fills: felt, not watched. */
  press: 120,
  tooltip: 120,
  popoverEnter: 160,
  popoverExit: 110,
  /** Switch thumb, segmented thumb: a small control moving across itself. */
  toggle: 180,
  toastEnter: 260,
  toastExit: 180,
  modalEnter: 200,
  modalExit: 150,
  /**
   * A checked-off action item stays in place this long after its mark settles, so the check is
   * seen before the row leaves its list. Chosen by eye, not derived: long enough to read the
   * struck-through line, short enough that a burst of closures does not stack up.
   */
  checkOffDwell: 500,
} as const;

/** Press feedback scale. Large enough to read as physical, small enough to stay out of the way. */
export const PRESS_SCALE = 0.97;
/** Popovers, menus, and modals enter from this scale, never from zero. */
export const SURFACE_ENTER_SCALE = 0.96;
/**
 * A check mark pops in from this scale. Smaller than `SURFACE_ENTER_SCALE` because the glyph is
 * 18px: at 0.96 the pop is under a pixel and reads as nothing. Chosen by eye, not derived.
 */
export const CHECK_POP_START_SCALE = 0.6;

/**
 * Web class that eases a pressable's press scale and hover fill and gives it a keyboard focus ring.
 * Apply it through Unistyles, `_web: { _classNames: PRESS_CLASS_NAME }`, and scale the pressed
 * style by `PRESS_SCALE`. The rules live in `install-web-motion-styles.web.ts`.
 */
export const PRESS_CLASS_NAME = "pimi-press";
