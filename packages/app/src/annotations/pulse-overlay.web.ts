import { ANNOTATION_PULSE_BOX_CLASS } from "./popover.web";

const FADE_MS = 800;
const PADDING_X_PX = 3;
const PADDING_Y_PX = 1;
const LINE_JOIN_TOLERANCE_PX = 2;

export const ANNOTATION_OVERLAY_TOTAL_MS = FADE_MS;

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** One box per text line: the fragments of a line (inline code, bold) merge into one. */
function lineBoxes(range: Range): Box[] {
  const boxes: Box[] = [];
  for (const rect of range.getClientRects()) {
    if (rect.width === 0 || rect.height === 0) continue;
    const line = boxes.find(
      (box) =>
        Math.abs(box.top - rect.top) < LINE_JOIN_TOLERANCE_PX + rect.height / 2 &&
        Math.abs(box.bottom - rect.bottom) < LINE_JOIN_TOLERANCE_PX + rect.height / 2,
    );
    if (line) {
      line.left = Math.min(line.left, rect.left);
      line.right = Math.max(line.right, rect.right);
      line.top = Math.min(line.top, rect.top);
      line.bottom = Math.max(line.bottom, rect.bottom);
    } else {
      boxes.push({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
    }
  }
  return boxes;
}

/**
 * Draws a soft rounded highlight over `range` and fades it in and out. The boxes are fixed
 * overlays outside the chat, so nothing in the list changes layout or restyles; only their
 * opacity is animated. They follow the range each frame while it is on screen.
 */
export function playQuotePulse(input: {
  range: Range;
  reducedMotion: boolean;
  onDone(): void;
}): () => void {
  const { range, reducedMotion, onDone } = input;
  const layer = document.createElement("div");
  layer.setAttribute("aria-hidden", "true");
  layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483000;";
  document.body.appendChild(layer);
  let frame = 0;
  let stopped = false;

  function place() {
    frame = 0;
    if (stopped) return;
    const boxes = lineBoxes(range);
    while (layer.childElementCount > boxes.length) layer.lastElementChild?.remove();
    boxes.forEach((box, index) => {
      let element = layer.children[index] as HTMLElement | undefined;
      if (!element) {
        element = document.createElement("div");
        element.className = ANNOTATION_PULSE_BOX_CLASS;
        layer.appendChild(element);
      }
      element.style.left = `${box.left - PADDING_X_PX}px`;
      element.style.top = `${box.top - PADDING_Y_PX}px`;
      element.style.width = `${box.right - box.left + PADDING_X_PX * 2}px`;
      element.style.height = `${box.bottom - box.top + PADDING_Y_PX * 2}px`;
    });
    frame = requestAnimationFrame(place);
  }
  place();

  const animation = layer.animate(
    reducedMotion
      ? [{ opacity: 1 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }]
      : [{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 0 }],
    { duration: FADE_MS, easing: "ease-out", fill: "both" },
  );
  animation.onfinish = () => {
    stop();
    onDone();
  };

  function stop() {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    animation.cancel();
    layer.remove();
  }
  return stop;
}
