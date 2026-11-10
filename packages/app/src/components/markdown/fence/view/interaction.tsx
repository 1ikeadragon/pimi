import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type PointerEvent,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { isWeb } from "@/constants/platform";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import type { Box, Point } from "./scene";

/** Anything in a scene the reader can point at, press, or reach with the keyboard. */
export interface InteractionTarget {
  /** Stable across updates of the same view, so an open popover follows its target. */
  key: string;
  description: string;
  anchor: Point;
  box: Box;
}

/**
 * Which target's popover is open, by key. Pointer, press and focus open one; leaving the scene,
 * blurring the target, or Escape closes it.
 */
export function useInspection(targets: readonly InteractionTarget[]) {
  const [inspectedKey, setInspectedKey] = useState<string | null>(null);
  const inspected = targets.findIndex(({ key }) => key === inspectedKey);
  const inspect = useCallback((key: string | null, open: boolean) => {
    setInspectedKey((current) => {
      if (open) return key;
      return key === null || current === key ? null : current;
    });
  }, []);
  useEffect(() => {
    if (!isWeb || inspected < 0) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setInspectedKey(null);
    };
    window.addEventListener("keydown", dismiss, true);
    return () => window.removeEventListener("keydown", dismiss, true);
  }, [inspected]);
  return { inspected, inspect };
}

function FocusTarget({
  target,
  index,
  testID,
  onSelect,
  onInspect,
}: {
  target: InteractionTarget;
  index: number;
  testID: string;
  onSelect: (index: number) => void;
  onInspect: (key: string, open: boolean) => void;
}) {
  const [focused, setFocused] = useState(false);
  const select = useCallback(() => onSelect(index), [index, onSelect]);
  const focus = useCallback(() => {
    setFocused(true);
    onSelect(index);
    onInspect(target.key, true);
  }, [index, onInspect, onSelect, target.key]);
  const blur = useCallback(() => {
    setFocused(false);
    onInspect(target.key, false);
  }, [onInspect, target.key]);
  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityLabel={target.description}
      testID={testID}
      onPress={select}
      onFocus={focus}
      onBlur={blur}
      style={[
        styles.focusTarget,
        inlineUnistylesStyle({
          left: target.box.x,
          top: target.box.y,
          width: target.box.width,
          height: target.box.height,
        }),
        focused && styles.focused,
      ]}
    />
  );
}

const POPOVER_GAP = 10;

/**
 * The popover for the inspected target, placed from the scene's own geometry. A portal tooltip
 * measures its anchor after mounting, which loses the race when the target changes under a moving
 * pointer. It sits beside the target, never over it: right of it while there is room, otherwise
 * left. With `clearBox`, it clears the target's whole box, and goes below or above the box when
 * neither side has room.
 */
export function ScenePopover({
  target,
  bounds,
  clearBox,
  children,
}: {
  target: InteractionTarget;
  bounds: { width: number; height: number };
  clearBox: boolean;
  children: ReactNode;
}) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const measure = useCallback(({ nativeEvent }: LayoutChangeEvent) => {
    const { width: measuredWidth, height } = nativeEvent.layout;
    setSize({ width: measuredWidth, height });
  }, []);
  const { anchor, box } = target;
  const position = useMemo(() => {
    // Laid out off-screen first; placement needs the measured size.
    if (!size) return { left: 0, top: 0, opacity: 0 };
    const reach = clearBox ? box.width / 2 : 0;
    const right = anchor.x + reach + POPOVER_GAP;
    const left = anchor.x - reach - POPOVER_GAP - size.width;
    const top = Math.max(0, anchor.y - size.height / 2);
    if (right + size.width <= bounds.width) return { left: right, top };
    if (!clearBox || left >= 0) return { left: Math.max(0, left), top };
    const centred = Math.max(0, Math.min(bounds.width - size.width, anchor.x - size.width / 2));
    const below = box.y + box.height + POPOVER_GAP;
    if (below + size.height <= bounds.height) return { left: centred, top: below };
    return { left: centred, top: Math.max(0, box.y - POPOVER_GAP - size.height) };
  }, [anchor.x, anchor.y, bounds.height, bounds.width, box, clearBox, size]);
  return (
    <View
      testID="chat-visualization-tooltip"
      accessible={false}
      onLayout={measure}
      style={[styles.popover, inlineUnistylesStyle(position)]}
    >
      {children}
    </View>
  );
}

/**
 * Selection for any scene. Pointer and touch are resolved against the scene's geometry by one
 * surface; each target also has its own element so a keyboard or screen reader can reach it.
 * Those elements take no pointer events, so the surface below them decides what was hit.
 */
export function SceneInteraction({
  targets,
  bounds,
  hitTest,
  inspected,
  onSelect,
  onInspect,
  renderPopover,
  clearBox = false,
  testIDPrefix = "chat-visualization-point",
}: {
  targets: readonly InteractionTarget[];
  bounds: { width: number; height: number };
  hitTest: (x: number, y: number) => number | null;
  inspected: number;
  onSelect: (index: number) => void;
  onInspect: (key: string | null, open: boolean) => void;
  /** The popover's content for a target, or null when that target has nothing to show. */
  renderPopover: (index: number) => ReactNode;
  clearBox?: boolean;
  testIDPrefix?: string;
}) {
  const hover = useCallback(
    ({ nativeEvent, currentTarget }: PointerEvent) => {
      if (nativeEvent.pointerType === "touch") return;
      // offsetX is relative to whichever child is under the pointer, so the position is taken
      // against the surface that owns the scene's coordinates.
      const surface = (currentTarget as unknown as Element).getBoundingClientRect();
      const index = hitTest(nativeEvent.clientX - surface.left, nativeEvent.clientY - surface.top);
      if (index === null) {
        onInspect(null, false);
        return;
      }
      onSelect(index);
      onInspect(targets[index].key, true);
    },
    [hitTest, onInspect, onSelect, targets],
  );
  const leave = useCallback(() => onInspect(null, false), [onInspect]);
  const press = useCallback(
    ({ nativeEvent }: GestureResponderEvent) => {
      const index = hitTest(nativeEvent.locationX, nativeEvent.locationY);
      if (index === null) return;
      onSelect(index);
      onInspect(targets[index].key, true);
    },
    [hitTest, onInspect, onSelect, targets],
  );
  const target = targets[inspected];
  const content = target ? renderPopover(inspected) : null;
  return (
    <View
      style={styles.fill}
      // Pointer events exist only on web; touch and native select by press below.
      {...(isWeb ? { onPointerMove: hover, onPointerLeave: leave } : null)}
    >
      <PressHighlight
        accessible={false}
        focusable={false}
        testID="chat-visualization-surface"
        style={styles.fill}
        onPress={press}
      />
      {targets.map((item, index) => (
        <FocusTarget
          key={item.key}
          target={item}
          index={index}
          testID={`${testIDPrefix}-${index}`}
          onSelect={onSelect}
          onInspect={onInspect}
        />
      ))}
      {target && content ? (
        <ScenePopover key={target.key} target={target} bounds={bounds} clearBox={clearBox}>
          {content}
        </ScenePopover>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  fill: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
  focusTarget: {
    position: "absolute",
    pointerEvents: "none",
    borderWidth: 1,
    borderColor: "transparent",
  },
  focused: {
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.sm,
  },
  popover: {
    position: "absolute",
    pointerEvents: "none",
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.popover,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    ...theme.shadow.md,
    zIndex: 2,
  },
}));
