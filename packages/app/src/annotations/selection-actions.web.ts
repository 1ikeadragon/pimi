// Adapted from T3 Code apps/web/src/lib/selectionActions.ts (MIT, © 2026 T3 Tools Inc.).

export interface SelectionPoint {
  x: number;
  y: number;
}

export interface SelectionEdges {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Where a selection toolbar goes, and the line it steps over when there is no room below. */
export interface SelectionActionPosition extends SelectionPoint {
  /** Top of the line the toolbar hangs under. */
  lineTop: number;
  bounds: SelectionEdges;
}

const MULTI_CLICK_INTERVAL_MS = 500;
const SCROLL_SETTLE_MS = 150;
const POINTER_SLACK = 8;
export const SELECTION_ACTION_GAP = 4;
export const WINDOW_EDGE_GAP = 8;

export function isPointNearRect(point: SelectionPoint, rect: SelectionEdges): boolean {
  return (
    point.x >= rect.left - POINTER_SLACK &&
    point.x <= rect.right + POINTER_SLACK &&
    point.y >= rect.top - POINTER_SLACK &&
    point.y <= rect.bottom + POINTER_SLACK
  );
}

export function isSelectionRectVisible(rect: SelectionEdges, clips: readonly SelectionEdges[]) {
  let { left, top, right, bottom } = rect;
  for (const clip of clips) {
    left = Math.max(left, clip.left);
    top = Math.max(top, clip.top);
    right = Math.min(right, clip.right);
    bottom = Math.min(bottom, clip.bottom);
  }
  return right > left && bottom > top;
}

/**
 * The toolbar opens where the pointer let go when that is on the selected text, and otherwise
 * under the end of the selection's last line.
 */
export function resolveSelectionActionPosition(input: {
  bounds: SelectionEdges;
  lastLine: SelectionEdges;
  /** The release point, when it landed on the selected text. */
  pointer: SelectionPoint | null;
}): SelectionActionPosition {
  const { bounds, lastLine, pointer } = input;
  if (pointer) {
    return {
      x: pointer.x,
      y: pointer.y + SELECTION_ACTION_GAP,
      lineTop: pointer.y - SELECTION_ACTION_GAP,
      bounds,
    };
  }
  return {
    x: lastLine.right,
    y: lastLine.bottom + SELECTION_ACTION_GAP,
    lineTop: lastLine.top,
    bounds,
  };
}

/** Keeps a floating surface inside its pane and off the window edges, above the line if needed. */
export function placeSelectionAction(
  position: SelectionActionPosition,
  size: { width: number; height: number },
): SelectionPoint {
  const { bounds } = position;
  const minLeft = Math.max(WINDOW_EDGE_GAP, bounds.left);
  const maxLeft = Math.min(window.innerWidth - WINDOW_EDGE_GAP, bounds.right) - size.width;
  const minTop = Math.max(WINDOW_EDGE_GAP, bounds.top);
  const maxTop = Math.min(window.innerHeight - WINDOW_EDGE_GAP, bounds.bottom) - size.height;
  const above = position.lineTop - SELECTION_ACTION_GAP - size.height;
  const top = position.y > maxTop && above >= minTop ? above : position.y;
  return {
    x: Math.max(minLeft, Math.min(position.x, maxLeft)),
    y: Math.max(minTop, Math.min(top, maxTop)),
  };
}

export interface SelectionActions {
  /** Forgets the current gesture without telling the owner. */
  cancel(): void;
  /** Call on every selection change; only keyboard-made selections open the toolbar from here. */
  selectionChanged(): void;
  dispose(): void;
}

function isNode(target: EventTarget | null): target is Node {
  return target instanceof Node;
}

/**
 * Turns pointer, keyboard and scroll events into "show the toolbar for the current selection"
 * and "hide it". A drag reports on release, a double or triple click after the multi-click
 * interval so a further click can still extend it, and a keyboard selection on the next frame.
 *
 * `getActionElements` names the toolbar and any open editor, so pressing or typing in them is
 * not read as a new gesture on the source.
 */
export function observeSelectionActions(input: {
  element: HTMLElement;
  getActionElements(): readonly (HTMLElement | null)[];
  onSelection(pointer: SelectionPoint | null): void;
  onDismiss(): void;
}): SelectionActions {
  const { element, getActionElements, onSelection, onDismiss } = input;
  let pointerDown = false;
  let gestureActive = false;
  // Nothing opens until the user makes a gesture, so a selection that was already there, or one
  // the app made, stays quiet.
  let dismissed = true;
  let restorable = false;
  let pointer: SelectionPoint | null = null;
  let timer: number | null = null;
  let frame: number | null = null;

  function isActionTarget(target: EventTarget | null): boolean {
    return isNode(target) && getActionElements().some((action) => action?.contains(target));
  }
  function hasActionElement(): boolean {
    return getActionElements().some((action) => action !== null);
  }
  function cancelPending() {
    if (timer !== null) window.clearTimeout(timer);
    if (frame !== null) window.cancelAnimationFrame(frame);
    timer = null;
    frame = null;
  }
  function cancel() {
    cancelPending();
    pointerDown = false;
    gestureActive = false;
    pointer = null;
    dismissed = true;
    restorable = false;
  }
  function dismiss() {
    cancel();
    onDismiss();
  }
  function schedule(delay: number) {
    restorable = true;
    cancelPending();
    timer = window.setTimeout(() => {
      timer = null;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        onSelection(pointer);
      });
    }, delay);
  }
  function onPointerDown(event: PointerEvent) {
    if (!event.isPrimary) return;
    if (isActionTarget(event.target)) {
      cancel();
      return;
    }
    cancelPending();
    pointerDown = event.button === 0;
    gestureActive = false;
    dismissed = true;
    restorable = false;
    pointer = null;
    const inside = isNode(event.target) && element.contains(event.target);
    if (inside || hasActionElement()) onDismiss();
  }
  function onSelectionStart(event: PointerEvent) {
    if (!event.isPrimary) return;
    if (event.target instanceof Element && event.target.closest("button, [role=button]")) return;
    gestureActive = event.button === 0 && !event.defaultPrevented;
    dismissed = !gestureActive;
  }
  function onPointerUp(event: PointerEvent) {
    // A prevented pointerdown, as on the toolbar, can suppress the matching mouseup.
    if (event.isPrimary && event.button === 0) pointerDown = false;
  }
  function onMouseUp(event: MouseEvent) {
    if (event.button !== 0) return;
    pointerDown = false;
    if (!gestureActive) return;
    gestureActive = false;
    pointer = { x: event.clientX, y: event.clientY };
    schedule(event.detail >= 2 ? MULTI_CLICK_INTERVAL_MS : 0);
  }
  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      dismiss();
      return;
    }
    if (isActionTarget(event.target) || pointerDown) return;
    cancelPending();
    gestureActive = false;
    pointer = null;
    dismissed = false;
  }
  function onFocusIn(event: FocusEvent) {
    if (isActionTarget(event.target)) cancel();
    else if (!pointerDown && hasActionElement()) dismiss();
  }
  function onScroll() {
    cancelPending();
    // Autoscroll during a drag must not cancel that gesture's eventual release.
    if (!pointerDown) {
      pointer = null;
      if (!dismissed && restorable) schedule(SCROLL_SETTLE_MS);
      else dismissed = true;
    }
    onDismiss();
  }

  document.addEventListener("pointerdown", onPointerDown, true);
  element.addEventListener("pointerdown", onSelectionStart);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("mouseup", onMouseUp);
  window.addEventListener("pointercancel", dismiss);
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("focusin", onFocusIn);
  element.addEventListener("contextmenu", dismiss, true);
  element.addEventListener("scroll", onScroll, true);
  window.addEventListener("blur", dismiss);
  window.addEventListener("resize", dismiss);

  return {
    cancel,
    selectionChanged() {
      if (isActionTarget(document.activeElement)) return;
      if (pointerDown || gestureActive) onDismiss();
      else if (!dismissed && timer === null && frame === null) schedule(0);
    },
    dispose() {
      cancel();
      document.removeEventListener("pointerdown", onPointerDown, true);
      element.removeEventListener("pointerdown", onSelectionStart);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("pointercancel", dismiss);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      element.removeEventListener("contextmenu", dismiss, true);
      element.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
    },
  };
}
