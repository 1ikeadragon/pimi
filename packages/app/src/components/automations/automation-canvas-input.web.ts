import { useEffect, useRef, type RefObject } from "react";
import type { View } from "react-native";
import type { AutomationEdgeBranch } from "@pimi/protocol/automation/types";
import type { CanvasDragConnectInput } from "./automation-canvas-input-types";

export type { CanvasDragConnectInput, CanvasDragLine } from "./automation-canvas-input-types";

const HANDLE_PREFIX = "automation-handle:";
const NODE_PREFIX = "automation-node:";
// Pointer travel before a press on a handle becomes a drag; a shorter press opens its menu.
const DRAG_THRESHOLD = 4;

function parseHandle(testId: string): { nodeId: string; branch: AutomationEdgeBranch | undefined } {
  const rest = testId.slice(HANDLE_PREFIX.length);
  const split = rest.lastIndexOf(":");
  const nodeId = rest.slice(0, split);
  const branch = rest.slice(split + 1);
  return { nodeId, branch: branch === "true" || branch === "false" ? branch : undefined };
}

function nodeUnder(x: number, y: number): string | null {
  for (const element of document.elementsFromPoint(x, y)) {
    const node = element.closest(`[data-testid^="${NODE_PREFIX}"]`);
    if (node) {
      return node.getAttribute("data-testid")?.slice(NODE_PREFIX.length) ?? null;
    }
  }
  return null;
}

/**
 * Web: drag from a step's handle onto another step to link them. The press is taken before the
 * viewport sees it, so the drag does not pan the canvas, and the click that ends a drag is
 * swallowed so the handle's menu stays shut.
 */
export function useCanvasDragConnect(
  root: RefObject<View | null>,
  input: CanvasDragConnectInput,
): void {
  const inputRef = useRef(input);
  inputRef.current = input;

  useEffect(() => {
    const element = root.current as unknown as HTMLElement | null;
    if (!element) {
      return;
    }
    let drag: {
      nodeId: string;
      branch: AutomationEdgeBranch | undefined;
      x: number;
      y: number;
      moved: boolean;
    } | null = null;

    const toCanvas = (clientX: number, clientY: number) => {
      const bounds = element.getBoundingClientRect();
      const scale = bounds.width / Math.max(1, inputRef.current.canvasWidth);
      return { x: (clientX - bounds.left) / scale, y: (clientY - bounds.top) / scale };
    };
    const swallowClick = (event: MouseEvent) => {
      event.stopPropagation();
      event.preventDefault();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || event.button !== 0) {
        return;
      }
      const handle = (event.target as Element | null)?.closest(`[data-testid^="${HANDLE_PREFIX}"]`);
      const testId = handle?.getAttribute("data-testid");
      if (!testId) {
        return;
      }
      event.stopPropagation();
      drag = { ...parseHandle(testId), x: event.clientX, y: event.clientY, moved: false };
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!drag) {
        return;
      }
      if (
        !drag.moved &&
        Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < DRAG_THRESHOLD
      ) {
        return;
      }
      drag.moved = true;
      const from = inputRef.current.handleOrigin(drag.nodeId, drag.branch);
      if (from) {
        inputRef.current.onDrag({ from, to: toCanvas(event.clientX, event.clientY) });
      }
    };
    const onPointerUp = (event: PointerEvent) => {
      const ended = drag;
      drag = null;
      if (!ended?.moved) {
        return;
      }
      window.addEventListener("click", swallowClick, { capture: true, once: true });
      inputRef.current.onDrag(null);
      const target = nodeUnder(event.clientX, event.clientY);
      if (target && target !== ended.nodeId) {
        inputRef.current.onConnect(ended.nodeId, target, ended.branch);
      }
    };
    element.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      element.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("click", swallowClick, { capture: true });
    };
  }, [root]);
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

/** Web: Delete or Backspace removes the selected step, unless a field has the keyboard. */
export function useDeleteSelectedStep(onDelete: (() => void) | null): void {
  const onDeleteRef = useRef(onDelete);
  onDeleteRef.current = onDelete;
  const enabled = onDelete !== null;
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Delete" && event.key !== "Backspace") {
        return;
      }
      if (event.defaultPrevented || isTyping(event.target) || isTyping(document.activeElement)) {
        return;
      }
      event.preventDefault();
      onDeleteRef.current?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}
