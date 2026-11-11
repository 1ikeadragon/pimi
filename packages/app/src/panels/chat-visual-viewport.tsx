import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { View, type LayoutChangeEvent, type ScrollView as RNScrollView } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { Maximize, ZoomIn, ZoomOut } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { ScrollView } from "@/components/ui/scroll-view";
import { isNative, isWeb } from "@/constants/platform";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
const STEP = 1.25;
// Pointer travel before a press on the content becomes a drag, so a click still inspects a node.
const DRAG_THRESHOLD = 4;
const FIT_PASSES = 3;

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

interface Size {
  width: number;
  height: number;
}

type ScrollNode = HTMLElement;

function scrollNodeOf(scroll: RNScrollView | null): ScrollNode | null {
  const node = (
    scroll as unknown as { getScrollableNode?: () => unknown } | null
  )?.getScrollableNode?.();
  return node instanceof HTMLElement ? node : null;
}

/**
 * The widest sideways overflow inside the content, as a ratio of the box it scrolls in. A flow
 * wider than its column scrolls inside itself; fitting has to make room for all of it.
 */
function innerOverflow(node: HTMLElement | null): number {
  if (!node) return 1;
  let ratio = 1;
  for (const element of node.querySelectorAll<HTMLElement>("*")) {
    if (element.clientWidth <= 0 || element.scrollWidth <= element.clientWidth + 1) continue;
    // Only a box that scrolls sideways hides content; clipped or visible overflow is drawing.
    const { overflowX } = getComputedStyle(element);
    if (overflowX !== "auto" && overflowX !== "scroll") continue;
    ratio = Math.max(ratio, element.scrollWidth / element.clientWidth);
  }
  return ratio;
}

/**
 * Pan and zoom for a visual opened in a tab. The content is laid out at the pane's width, so
 * charts, flows and tables use the room. Zooming in magnifies that layout; zooming out lays it out
 * again wider, so a flow or table that scrolled sideways gets the width to show all of it. Pan
 * with the scroll bars, the wheel or a drag; zoom with ctrl or ⌘ and the wheel, a trackpad pinch,
 * a touch pinch on native, or the buttons.
 */
export function ChatVisualViewport({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [viewport, setViewport] = useState<Size | null>(null);
  const [content, setContent] = useState<Size | null>(null);
  const [scale, setScale] = useState(1);
  const scaleRef = useRef(1);
  const vertical = useRef<RNScrollView>(null);
  const horizontal = useRef<RNScrollView>(null);
  const contentNode = useRef<View>(null);
  // Below 100% the content is laid out wider by the same factor, so it still fills the pane.
  const layoutWidth = viewport ? Math.max(1, Math.floor(viewport.width / Math.min(scale, 1))) : 0;

  const measureViewport = useCallback(({ nativeEvent }: LayoutChangeEvent) => {
    const { width, height } = nativeEvent.layout;
    // A hidden retained panel reports zero; keep the last real size.
    if (width > 0 && height > 0) setViewport({ width, height });
  }, []);
  const measureContent = useCallback(({ nativeEvent }: LayoutChangeEvent) => {
    const { width, height } = nativeEvent.layout;
    if (width > 0 && height > 0) setContent({ width, height });
  }, []);

  /** Zooms keeping the content point under `focus` (viewport pixels) where it is. */
  const zoomTo = useCallback((next: number, focus?: { x: number; y: number }) => {
    const previous = scaleRef.current;
    const target = clampScale(next);
    if (target === previous) return;
    scaleRef.current = target;
    setScale(target);
    if (!isWeb) return;
    const outer = scrollNodeOf(vertical.current);
    const inner = scrollNodeOf(horizontal.current);
    if (!outer || !inner) return;
    const x = focus?.x ?? 0;
    const y = focus?.y ?? 0;
    const ratio = target / previous;
    const left = (inner.scrollLeft + x) * ratio - x;
    const top = (outer.scrollTop + y) * ratio - y;
    // The scaled frame grows on the next render; scroll once it is there.
    requestAnimationFrame(() => {
      inner.scrollLeft = left;
      outer.scrollTop = top;
    });
  }, []);

  const zoomIn = useCallback(() => zoomTo(scaleRef.current * STEP), [zoomTo]);
  const zoomOut = useCallback(() => zoomTo(scaleRef.current / STEP), [zoomTo]);
  const actualSize = useCallback(() => zoomTo(1), [zoomTo]);
  // At or below 100% the width always fits, so fitting shrinks for the height and for anything
  // that still scrolls sideways inside the content. Laying out wider can change both, so a fit
  // measures again after each new layout, a few times at most.
  const fitPasses = useRef(0);
  const fitOnce = useCallback(() => {
    if (!viewport || !content) return;
    const overflow = isWeb ? innerOverflow(contentNode.current as unknown as HTMLElement) : 1;
    zoomTo(
      Math.min(1, viewport.width / (layoutWidth * overflow), viewport.height / content.height),
    );
  }, [content, layoutWidth, viewport, zoomTo]);
  const fit = useCallback(() => {
    fitPasses.current = FIT_PASSES;
    fitOnce();
  }, [fitOnce]);
  useEffect(() => {
    if (fitPasses.current <= 0) return;
    fitPasses.current -= 1;
    fitOnce();
  }, [fitOnce]);

  // Web: ctrl/⌘ + wheel (and a trackpad pinch, which the browser reports as one) zooms; a plain
  // wheel scrolls; a drag with the mouse pans.
  useEffect(() => {
    if (!isWeb) return;
    const outer = scrollNodeOf(vertical.current);
    const inner = scrollNodeOf(horizontal.current);
    if (!outer || !inner) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const bounds = outer.getBoundingClientRect();
      zoomTo(scaleRef.current * Math.exp(-event.deltaY / 500), {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      });
    };
    let drag: { x: number; y: number; left: number; top: number; moved: boolean } | null = null;
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || event.button !== 0) return;
      // A press on a scroll bar moves the bar, not the content.
      for (const node of [outer, inner]) {
        const bounds = node.getBoundingClientRect();
        if (
          event.clientX - bounds.left > node.clientWidth ||
          event.clientY - bounds.top > node.clientHeight
        )
          return;
      }
      drag = {
        x: event.clientX,
        y: event.clientY,
        left: inner.scrollLeft,
        top: outer.scrollTop,
        moved: false,
      };
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!drag) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!drag.moved) {
        drag.moved = true;
        outer.style.cursor = "grabbing";
        outer.style.userSelect = "none";
        window.getSelection()?.removeAllRanges();
      }
      inner.scrollLeft = drag.left - dx;
      outer.scrollTop = drag.top - dy;
    };
    const onPointerUp = () => {
      if (drag?.moved) {
        // The drag ends with a click on whatever is under the pointer; it is not a press.
        window.addEventListener("click", swallowClick, { capture: true, once: true });
      }
      drag = null;
      outer.style.cursor = "";
      outer.style.userSelect = "";
    };
    const swallowClick = (event: MouseEvent) => {
      event.stopPropagation();
      event.preventDefault();
    };
    outer.addEventListener("wheel", onWheel, { passive: false });
    outer.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      outer.removeEventListener("wheel", onWheel);
      outer.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("click", swallowClick, { capture: true });
    };
  }, [zoomTo]);

  // Native: pinch zooms; the scroll views pan.
  const pinchStart = useRef(1);
  const pinch = useMemo(
    () =>
      Gesture.Pinch()
        .enabled(isNative)
        .runOnJS(true)
        .onStart(() => {
          pinchStart.current = scaleRef.current;
        })
        .onUpdate((event) => zoomTo(pinchStart.current * event.scale)),
    [zoomTo],
  );

  const frameStyle = useMemo(
    () =>
      inlineUnistylesStyle(
        content
          ? { width: content.width * scale, height: content.height * scale }
          : { width: layoutWidth },
      ),
    [content, layoutWidth, scale],
  );
  const contentStyle = useMemo(
    () =>
      inlineUnistylesStyle({
        width: layoutWidth,
        transform: [{ scale }],
        transformOrigin: "top left",
      }),
    [layoutWidth, scale],
  );

  return (
    <View style={styles.root} testID="chat-visual-viewport">
      <GestureDetector gesture={pinch}>
        <ScrollView ref={vertical} style={styles.fill} onLayout={measureViewport}>
          <ScrollView ref={horizontal} horizontal showsHorizontalScrollIndicator>
            {layoutWidth > 0 ? (
              <View style={frameStyle}>
                <View ref={contentNode} style={contentStyle} onLayout={measureContent}>
                  {children}
                </View>
              </View>
            ) : null}
          </ScrollView>
        </ScrollView>
      </GestureDetector>
      <View style={styles.toolbar}>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={ZoomOut}
          accessibilityLabel={t("message.diagram.zoomOut")}
          disabled={scale <= MIN_SCALE}
          onPress={zoomOut}
          testID="chat-visual-zoom-out"
        />
        <Button
          variant="ghost"
          size="sm"
          accessibilityLabel={t("message.diagram.resetZoom")}
          onPress={actualSize}
          testID="chat-visual-zoom-reset"
        >
          {`${Math.round(scale * 100)}%`}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={ZoomIn}
          accessibilityLabel={t("message.diagram.zoomIn")}
          disabled={scale >= MAX_SCALE}
          onPress={zoomIn}
          testID="chat-visual-zoom-in"
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={Maximize}
          accessibilityLabel={t("message.diagram.fit")}
          onPress={fit}
          testID="chat-visual-zoom-fit"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, minHeight: 0, position: "relative" },
  fill: { flex: 1, minHeight: 0 },
  toolbar: {
    position: "absolute",
    // Bottom right, where it covers less than over a sequence's participants or a table's header.
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
