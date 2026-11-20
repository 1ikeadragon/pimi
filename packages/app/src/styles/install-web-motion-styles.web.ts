import { motionCss, motionDuration, PRESS_CLASS_NAME } from "@/styles/motion";

const STYLE_ID = "pimi-web-motion-styles";

/**
 * Shared web chrome for pressables that opt in with `PRESS_CLASS_NAME`: the press scale and hover
 * fills ease instead of switching in one frame, keyboard focus gets a visible ring, and reduced
 * motion drops the scale. The pressed scale itself comes from the primitive's pressed style:
 * `:active` never matches here because pointer-down is handled before the browser activates.
 */
export function installWebMotionStyles(): () => void {
  if (document.getElementById(STYLE_ID)) return () => {};

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.${PRESS_CLASS_NAME} {
  transition-property: transform, background-color, border-color;
  transition-duration: ${motionDuration.press}ms;
  transition-timing-function: ${motionCss.out}, ease, ease;
}

.${PRESS_CLASS_NAME}:focus-visible {
  outline: 2px solid var(--colors-accent);
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  .${PRESS_CLASS_NAME} {
    transform: none !important;
  }
}
`;
  document.head.append(style);

  return () => style.remove();
}
