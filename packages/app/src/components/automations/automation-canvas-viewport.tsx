import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { Maximize, ZoomIn, ZoomOut } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { isNative, isWeb } from "@/constants/platform";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
const STEP = 1.25;
const FIT_MARGIN = 32;
// Pointer travel before a press on the canvas becomes a pan, so a tap still selects a node.
const DRAG_THRESHOLD = 4;
// Panning stops with this much of the graph still on screen.
const KEEP_VISIBLE = 80;

interface Transform {
  scale: number;
  x: number;
  y: number;
}

interface Size {
  width: number;
  height: number;
}

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** Scales and centres the graph in the room below `topInset`, never enlarging past 100%. */
function fitTransform(content: Size, viewport: Size, topInset: number): Transform {
  const room = { width: viewport.width, height: Math.max(1, viewport.height - topInset) };
  const scale = clampScale(
    Math.min(
      1,
      (room.width - FIT_MARGIN * 2) / content.width,
      (room.height - FIT_MARGIN * 2) / content.height,
    ),
  );
  return {
    scale,
    x: (room.width - content.width * scale) / 2,
    y: topInset + (room.height - content.height * scale) / 2,
  };
}

function clampPan(next: Transform, content: Size, viewport: Size): Transform {
  const keepX = Math.min(KEEP_VISIBLE, content.width * next.scale);
  const keepY = Math.min(KEEP_VISIBLE, content.height * next.scale);
  return {
    scale: next.scale,
    x: Math.min(viewport.width - keepX, Math.max(keepX - content.width * next.scale, next.x)),
    y: Math.min(viewport.height - keepY, Math.max(keepY - content.height * next.scale, next.y)),
  };
}

/** Zooms to `scale` keeping the content point under `focus` (viewport pixels) where it is. */
function zoomAround(from: Transform, scale: number, focus: { x: number; y: number }): Transform {
  const target = clampScale(scale);
  const ratio = target / from.scale;
  return {
    scale: target,
    x: focus.x - (focus.x - from.x) * ratio,
    y: focus.y - (focus.y - from.y) * ratio,
  };
}

/**
 * Pan and zoom for the automation graph: one layer, `width` by `height` in canvas pixels, moved
 * by a transform. A graph that fits can still be dragged anywhere, and Fit centres it on both
 * axes. Drag the canvas (or a node) to pan; the wheel pans, and ctrl or ⌘ with the wheel, a
 * trackpad pinch or a two-finger pinch zooms at the pointer. `topInset` is the strip at the top
 * that an overlay covers, so a fitted graph never runs under it.
 */
export function AutomationCanvasViewport({
  width,
  height,
  topInset,
  fitKey,
  children,
}: {
  width: number;
  height: number;
  topInset: number;
  /** Fits again whenever this changes, such as when the graph gains a node. */
  fitKey: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const content = useMemo<Size>(() => ({ width, height }), [height, width]);
  const [viewport, setViewport] = useState<Size | null>(null);
  const [transform, setTransform] = useState<Transform>({ scale: 1, x: 0, y: 0 });
  const transformRef = useRef(transform);
  const viewportRef = useRef<Size | null>(null);
  const contentRef = useRef(content);
  contentRef.current = content;
  const topInsetRef = useRef(topInset);
  topInsetRef.current = topInset;
  // Set once the person pans or zooms; a resize then leaves their view alone.
  const touched = useRef(false);
  const surface = useRef<View>(null);

  const apply = useCallback((next: Transform) => {
    const size = viewportRef.current;
    const clamped = size ? clampPan(next, contentRef.current, size) : next;
    transformRef.current = clamped;
    setTransform(clamped);
  }, []);

  const fit = useCallback(() => {
    const size = viewportRef.current;
    if (!size) return;
    touched.current = false;
    apply(fitTransform(contentRef.current, size, topInsetRef.current));
  }, [apply]);

  const measure = useCallback(
    ({ nativeEvent }: LayoutChangeEvent) => {
      const { width: w, height: h } = nativeEvent.layout;
      // A hidden retained screen reports zero; keep the last real size.
      if (w <= 0 || h <= 0) return;
      viewportRef.current = { width: w, height: h };
      setViewport({ width: w, height: h });
      if (!touched.current)
        apply(fitTransform(contentRef.current, { width: w, height: h }, topInsetRef.current));
    },
    [apply],
  );

  const measured = viewport !== null;
  useEffect(() => {
    if (measured) fit();
  }, [fit, fitKey, measured, topInset]);

  const panBy = useCallback(
    (dx: number, dy: number) => {
      touched.current = true;
      const current = transformRef.current;
      apply({ ...current, x: current.x + dx, y: current.y + dy });
    },
    [apply],
  );
  const zoomTo = useCallback(
    (scale: number, focus?: { x: number; y: number }) => {
      const size = viewportRef.current;
      if (!size) return;
      touched.current = true;
      apply(
        zoomAround(transformRef.current, scale, focus ?? { x: size.width / 2, y: size.height / 2 }),
      );
    },
    [apply],
  );
  const zoomIn = useCallback(() => zoomTo(transformRef.current.scale * STEP), [zoomTo]);
  const zoomOut = useCallback(() => zoomTo(transformRef.current.scale / STEP), [zoomTo]);
  const actualSize = useCallback(() => zoomTo(1), [zoomTo]);

  // Web: pointer drag pans (mouse, pen and one finger), two fingers pinch, the wheel pans and
  // ctrl/⌘ + wheel zooms. A press on a link handle stops propagation before it gets here.
  useEffect(() => {
    if (!isWeb) return;
    const node = surface.current as unknown as HTMLElement | null;
    if (!node) return;
    // Without this the browser takes a touch drag for a page scroll.
    node.style.touchAction = "none";
    const pointers = new Map<number, { x: number; y: number }>();
    let moved = false;
    let pinchDistance = 0;
    const local = (clientX: number, clientY: number) => {
      const bounds = node.getBoundingClientRect();
      return { x: clientX - bounds.left, y: clientY - bounds.top };
    };
    const swallowClick = (event: MouseEvent) => {
      event.stopPropagation();
      event.preventDefault();
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        zoomTo(
          transformRef.current.scale * Math.exp(-event.deltaY / 500),
          local(event.clientX, event.clientY),
        );
        return;
      }
      panBy(-event.deltaX, -event.deltaY);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
      }
    };
    const onPointerMove = (event: PointerEvent) => {
      const previous = pointers.get(event.pointerId);
      if (!previous) return;
      const point = { x: event.clientX, y: event.clientY };
      if (pointers.size === 1) {
        if (!moved && Math.hypot(point.x - previous.x, point.y - previous.y) < DRAG_THRESHOLD)
          return;
        if (!moved) {
          moved = true;
          node.style.cursor = "grabbing";
          node.style.userSelect = "none";
          window.getSelection()?.removeAllRanges();
        }
        pointers.set(event.pointerId, point);
        panBy(point.x - previous.x, point.y - previous.y);
        return;
      }
      pointers.set(event.pointerId, point);
      if (pointers.size !== 2) return;
      moved = true;
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDistance > 0) {
        zoomTo(
          transformRef.current.scale * (distance / pinchDistance),
          local((a.x + b.x) / 2, (a.y + b.y) / 2),
        );
      }
      pinchDistance = distance;
    };
    const onPointerEnd = (event: PointerEvent) => {
      if (!pointers.delete(event.pointerId)) return;
      if (pointers.size > 0) return;
      if (moved) {
        // A mouse drag ends with a click on whatever is under the pointer; it is not a press. A
        // touch drag sends none, so the listener goes before it could eat the next tap.
        window.addEventListener("click", swallowClick, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", swallowClick, { capture: true }), 0);
      }
      moved = false;
      pinchDistance = 0;
      node.style.cursor = "";
      node.style.userSelect = "";
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    node.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);
    return () => {
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
      window.removeEventListener("click", swallowClick, { capture: true });
    };
  }, [panBy, zoomTo]);

  // Native: a pan (after 8px, so taps still reach nodes) and a pinch, together.
  const gesture = useMemo(() => {
    const start = { x: 0, y: 0, scale: 1 };
    const pan = Gesture.Pan()
      .enabled(isNative)
      .minDistance(8)
      .runOnJS(true)
      .onStart(() => {
        start.x = transformRef.current.x;
        start.y = transformRef.current.y;
      })
      .onUpdate((event) => {
        touched.current = true;
        apply({
          ...transformRef.current,
          x: start.x + event.translationX,
          y: start.y + event.translationY,
        });
      });
    const pinch = Gesture.Pinch()
      .enabled(isNative)
      .runOnJS(true)
      .onStart(() => {
        start.scale = transformRef.current.scale;
      })
      .onUpdate((event) => zoomTo(start.scale * event.scale, { x: event.focalX, y: event.focalY }));
    return Gesture.Simultaneous(pan, pinch);
  }, [apply, zoomTo]);

  const layerStyle = useMemo(
    () =>
      inlineUnistylesStyle({
        width,
        height,
        transform: [
          { translateX: transform.x },
          { translateY: transform.y },
          { scale: transform.scale },
        ],
      }),
    [height, transform, width],
  );

  return (
    <View style={styles.root} onLayout={measure} testID="automation-canvas-viewport">
      <GestureDetector gesture={gesture}>
        <View ref={surface} style={styles.surface}>
          {viewport ? <View style={[styles.layer, layerStyle]}>{children}</View> : null}
        </View>
      </GestureDetector>
      <View style={styles.toolbar}>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={ZoomOut}
          accessibilityLabel={t("message.diagram.zoomOut")}
          disabled={transform.scale <= MIN_SCALE}
          onPress={zoomOut}
          testID="automation-canvas-zoom-out"
        />
        <Button
          variant="ghost"
          size="sm"
          accessibilityLabel={t("message.diagram.resetZoom")}
          onPress={actualSize}
          testID="automation-canvas-zoom-reset"
        >
          {`${Math.round(transform.scale * 100)}%`}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={ZoomIn}
          accessibilityLabel={t("message.diagram.zoomIn")}
          disabled={transform.scale >= MAX_SCALE}
          onPress={zoomIn}
          testID="automation-canvas-zoom-in"
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={Maximize}
          accessibilityLabel={t("message.diagram.fit")}
          onPress={fit}
          testID="automation-canvas-zoom-fit"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, minHeight: 0, position: "relative", overflow: "hidden" },
  layer: { position: "absolute", left: 0, top: 0, transformOrigin: "top left" },
  surface: { ...StyleSheet.absoluteFillObject, overflow: "hidden" },
  toolbar: {
    position: "absolute",
    bottom: theme.spacing[3],
    right: theme.spacing[4],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
}));
