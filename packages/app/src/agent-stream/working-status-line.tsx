import React, {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { ChevronRight } from "lucide-react-native";
import { useTranslation } from "@/i18n/use-translation";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AssistantForkMenu } from "@/components/assistant-fork-menu";
import { LiveElapsed, STREAM_METADATA_FONT_SIZE } from "@/components/message";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { WorkingPimi } from "@/components/working-pimi";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import type { InFlightTurnForkHandler } from "./turn-footer";
import type { WorkingStatusKind } from "./working-status";

// A short turn should not flash a timer; show elapsed time only once it is worth reading.
const ELAPSED_VISIBLE_AFTER_MS = 5000;
// Each label stays at least this long, so a burst of tool calls reads as a few steady labels.
const LABEL_MIN_DWELL_MS = 400;
// The gap between two tool calls reports the generic fallback; keep the specific label this long.
const SPECIFIC_STICKY_MS = 1500;
const OUTGOING_MS = 140;
const INCOMING_MS = 180;
const SLIDE_PX = 4;
const LABEL_MAX_WIDTH = 440;
export const STATUS_LINE_HEIGHT = 24;

export interface WorkingStatusLineProps {
  kind: WorkingStatusKind;
  label: string;
  specific: boolean;
  urgent: boolean;
  /** Calls and thoughts in the live run; 0 when the run is absent. */
  stepCount: number;
  failedCount: number;
  /** A live run exists, so the line can open its steps. */
  canExpand: boolean;
  expanded: boolean;
  onToggleSteps: () => void;
  inFlightTurnStartedAt: Date | null;
  onForkInFlightTurn?: InFlightTurnForkHandler;
}

interface ShownStatus {
  label: string;
  kind: WorkingStatusKind;
  specific: boolean;
}

/**
 * The label to show: the newest status, held back so a burst of tool calls does not strobe and
 * the gap between two calls does not read "Working". Waiting and stopping apply at once.
 */
function useThrottledStatus(
  target: ShownStatus & { urgent: boolean },
  active: boolean,
): ShownStatus {
  const [shown, setShown] = useState<ShownStatus>({
    label: target.label,
    kind: target.kind,
    specific: target.specific,
  });
  const shownRef = useRef(shown);
  const lastChangeAtRef = useRef(Date.now());
  const specificEndedAtRef = useRef(0);
  const targetWasSpecificRef = useRef(target.specific);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { label, kind, specific, urgent } = target;
  useEffect(() => {
    const clear = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
    const commit = () => {
      clear();
      const next = { label, kind, specific };
      if (
        shownRef.current.label === next.label &&
        shownRef.current.kind === next.kind &&
        shownRef.current.specific === next.specific
      ) {
        return;
      }
      shownRef.current = next;
      lastChangeAtRef.current = Date.now();
      setShown(next);
    };
    if (targetWasSpecificRef.current && !specific) specificEndedAtRef.current = Date.now();
    targetWasSpecificRef.current = specific;

    const evaluate = () => {
      const now = Date.now();
      let wait = lastChangeAtRef.current + LABEL_MIN_DWELL_MS - now;
      if (!specific && shownRef.current.specific) {
        wait = Math.max(wait, specificEndedAtRef.current + SPECIFIC_STICKY_MS - now);
      }
      if (wait <= 0) {
        commit();
        return;
      }
      timerRef.current = setTimeout(evaluate, wait);
    };

    // An inactive panel runs no timers; it shows the newest status and animates nothing.
    if (urgent || !active) {
      commit();
      return clear;
    }
    clear();
    evaluate();
    return clear;
  }, [active, kind, label, specific, urgent]);

  return shown;
}

/**
 * Two stacked copies of the label cross-fade with a short vertical slide. The slot's width follows
 * the incoming label so what sits beside it glides rather than snaps.
 */
const StatusLabel = memo(function StatusLabel({
  text,
  emphasized,
  animate,
}: {
  text: string;
  emphasized: boolean;
  animate: boolean;
}) {
  const [layers, setLayers] = useState({ incoming: text, outgoing: "" });
  if (layers.incoming !== text) {
    setLayers({ incoming: text, outgoing: layers.incoming });
  }
  const progress = useSharedValue(1);
  const width = useSharedValue(-1);
  const textStyle = emphasized ? stylesheet.labelEmphasized : stylesheet.label;

  useLayoutEffect(() => {
    if (!animate) {
      progress.value = 1;
      return;
    }
    progress.value = 0;
    progress.value = withTiming(1, { duration: INCOMING_MS, easing: Easing.out(Easing.quad) });
  }, [animate, layers.incoming, progress]);

  const handleMeasure = useCallback(
    (event: LayoutChangeEvent) => {
      const next = Math.min(LABEL_MAX_WIDTH, Math.ceil(event.nativeEvent.layout.width) + 1);
      if (width.value < 0 || !animate) {
        width.value = next;
      } else {
        width.value = withTiming(next, { duration: INCOMING_MS, easing: Easing.out(Easing.quad) });
      }
    },
    [animate, width],
  );

  const slotStyle = useAnimatedStyle(() => (width.value < 0 ? {} : { width: width.value }));
  const incomingStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * SLIDE_PX }],
  }));
  const outgoingStyle = useAnimatedStyle(() => {
    const out = Math.min(1, (progress.value * INCOMING_MS) / OUTGOING_MS);
    return { opacity: 1 - out, transform: [{ translateY: -out * SLIDE_PX }] };
  });

  return (
    <>
      <Animated.View style={[stylesheet.slot, slotStyle]}>
        {layers.outgoing ? (
          <Animated.View style={[stylesheet.layer, outgoingStyle]} pointerEvents="none">
            <Text style={textStyle} numberOfLines={1}>
              {layers.outgoing}
            </Text>
          </Animated.View>
        ) : null}
        <Animated.View style={[stylesheet.layer, incomingStyle]}>
          <Text style={textStyle} numberOfLines={1} testID="turn-working-label">
            {layers.incoming}
          </Text>
        </Animated.View>
      </Animated.View>
      <View style={stylesheet.measureClip} pointerEvents="none" aria-hidden>
        <View style={stylesheet.measurer}>
          <Text style={textStyle} numberOfLines={1} onLayout={handleMeasure}>
            {layers.incoming}
          </Text>
        </View>
      </View>
    </>
  );
});

const StepsSummary = memo(function StepsSummary({
  stepCount,
  failedCount,
  expanded,
  showChevron,
}: {
  stepCount: number;
  failedCount: number;
  expanded: boolean;
  showChevron: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      {stepCount >= 2 ? (
        <Text style={stylesheet.count} numberOfLines={1} testID="turn-working-steps">
          {`· ${t(stepCount === 1 ? "agentStream.working.steps.one" : "agentStream.working.steps.other", { count: stepCount })}`}
        </Text>
      ) : null}
      {failedCount > 0 ? (
        <Text style={stylesheet.failed} numberOfLines={1} testID="turn-working-failed">
          {`· ${t("agentStream.working.failed", { count: failedCount })}`}
        </Text>
      ) : null}
      <View
        style={[
          stylesheet.chevron,
          showChevron ? null : stylesheet.chevronHidden,
          expanded ? stylesheet.chevronOpen : null,
        ]}
        pointerEvents="none"
      >
        <ThemedChevron size={14} uniProps={mutedMapping} />
      </View>
    </>
  );
});

const ThemedChevron = withUnistyles(ChevronRight);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function DelayedElapsed({ startedAt, active }: { startedAt: Date; active: boolean }) {
  const startedAtMs = startedAt.getTime();
  const [visible, setVisible] = useState(
    () => Date.now() - startedAtMs >= ELAPSED_VISIBLE_AFTER_MS,
  );
  useEffect(() => {
    const remaining = ELAPSED_VISIBLE_AFTER_MS - (Date.now() - startedAtMs);
    if (remaining <= 0) {
      setVisible(true);
      return;
    }
    setVisible(false);
    const handle = setTimeout(() => setVisible(true), remaining);
    return () => clearTimeout(handle);
  }, [startedAtMs]);
  if (!visible) {
    return null;
  }
  return (
    <LiveElapsed
      startedAt={startedAt}
      active={active}
      style={stylesheet.elapsed}
      testID="turn-working-elapsed"
    />
  );
}

/**
 * The running turn's one status line: mascot, what it is doing, how many steps so far. Label
 * throttling and animation live here so a label change re-renders this leaf and nothing above.
 */
export const WorkingStatusLine = memo(function WorkingStatusLine({
  kind,
  label,
  specific,
  urgent,
  stepCount,
  failedCount,
  canExpand,
  expanded,
  onToggleSteps,
  inFlightTurnStartedAt,
  onForkInFlightTurn,
}: WorkingStatusLineProps) {
  const { t } = useTranslation();
  const active = useRetainedPanelActive();
  const reduceMotion = useReducedMotion();
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const shown = useThrottledStatus({ label, kind, specific, urgent }, active);
  const waiting = shown.kind === "waiting";
  const toggleLabel = t(
    expanded ? "agentStream.working.hideSteps" : "agentStream.working.showSteps",
  );
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);

  return (
    <View style={stylesheet.content}>
      <View style={stylesheet.loader}>
        <WorkingPimi size={18} waiting={waiting} />
      </View>
      <View
        style={stylesheet.hoverTarget}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
      >
        <PressHighlight
          style={stylesheet.pressable}
          disabled={!canExpand}
          onPress={onToggleSteps}
          accessibilityRole={canExpand ? "button" : undefined}
          accessibilityLabel={canExpand ? toggleLabel : undefined}
          accessibilityState={accessibilityState}
          testID="turn-working-toggle"
        >
          <StatusLabel text={shown.label} emphasized={waiting} animate={active && !reduceMotion} />
          {canExpand ? (
            <StepsSummary
              stepCount={waiting ? 0 : stepCount}
              failedCount={failedCount}
              expanded={expanded}
              showChevron={isHovered || isNative || isCompact || expanded}
            />
          ) : null}
        </PressHighlight>
      </View>
      {/* Match the completed-turn footer: actions precede timing metadata. */}
      {onForkInFlightTurn ? <AssistantForkMenu onFork={onForkInFlightTurn} /> : null}
      {inFlightTurnStartedAt ? (
        <DelayedElapsed startedAt={inFlightTurnStartedAt} active={active} />
      ) : null}
    </View>
  );
});

const stylesheet = StyleSheet.create((theme) => ({
  content: {
    height: STATUS_LINE_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    flexShrink: 1,
    gap: theme.spacing[3],
  },
  loader: {
    marginLeft: -2,
  },
  hoverTarget: {
    flexShrink: 1,
    minWidth: 0,
  },
  pressable: {
    height: STATUS_LINE_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 1,
    gap: theme.spacing[2],
  },
  slot: {
    height: STATUS_LINE_HEIGHT,
    flexShrink: 1,
    maxWidth: LABEL_MAX_WIDTH,
    overflow: "hidden",
  },
  layer: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    justifyContent: "center",
  },
  // Measures the label at its natural width. The zero-size clip keeps the wide measurer from
  // adding scrollable overflow.
  measureClip: {
    position: "absolute",
    left: 0,
    top: 0,
    width: 0,
    height: 0,
    overflow: "hidden",
  },
  measurer: {
    width: LABEL_MAX_WIDTH,
    alignItems: "flex-start",
    opacity: 0,
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: STREAM_METADATA_FONT_SIZE,
  },
  labelEmphasized: {
    color: theme.colors.foreground,
    fontSize: STREAM_METADATA_FONT_SIZE,
  },
  count: {
    color: theme.colors.foregroundMuted,
    fontSize: STREAM_METADATA_FONT_SIZE,
    fontVariant: ["tabular-nums"],
    flexShrink: 0,
  },
  failed: {
    color: theme.colors.destructive,
    fontSize: STREAM_METADATA_FONT_SIZE,
    fontVariant: ["tabular-nums"],
    flexShrink: 0,
  },
  chevron: {
    width: 14,
    height: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  chevronHidden: {
    opacity: 0,
  },
  chevronOpen: {
    transform: [{ rotate: "90deg" }],
  },
  elapsed: {
    color: theme.colors.foregroundMuted,
    fontSize: STREAM_METADATA_FONT_SIZE,
    fontVariant: ["tabular-nums"],
  },
}));
