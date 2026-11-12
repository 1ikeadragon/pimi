import React, { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { SPACING, type Theme } from "@/styles/theme";
import type { TurnTiming } from "@/timeline/turn-time";
import type { StreamItem } from "@/types/stream";
import {
  collectAssistantResponseContentForStreamRenderStrategy,
  type StreamStrategy,
} from "./strategy";
import { resolveAssistantTurnForkBoundary, type AssistantTurnForkBoundary } from "./turn-boundary";
import {
  AssistantTurnFooter,
  LiveElapsed,
  STREAM_METADATA_FONT_SIZE,
  type AssistantForkTarget,
} from "@/components/message";
import type { TurnFooterHost } from "./layout";
import { AssistantForkMenu } from "@/components/assistant-fork-menu";
import { WorkingPimi } from "@/components/working-pimi";
import { getStatusDotColor } from "@/utils/status-dot-color";
import type { WorkingStatusKind } from "./working-status";
import { useRetainedPanelActive } from "@/components/retained-panel";

const ThemedWorkingPimi = withUnistyles(WorkingPimi);
const workingPimiColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
// Waiting for the user is the needs-input state, so it takes the same amber as the sidebar dot.
const waitingPimiColorMapping = (theme: Theme) => ({
  color: getStatusDotColor({ theme, bucket: "needs_input" }) ?? theme.colors.foreground,
});
// A short turn should not flash a timer; show elapsed time only once it is worth reading.
const ELAPSED_VISIBLE_AFTER_MS = 5000;
export const TURN_FOOTER_BOTTOM_SPACING = SPACING[8];
// Every footer variant (running, completed with Copy, completed with only its duration) gets
// this content height, so a turn ending swaps the footer's controls without moving the rows
// above it.
const TURN_FOOTER_CONTENT_HEIGHT = 24;

export type TurnContentStrategy = StreamStrategy;
export type AssistantTurnForkHandler = (input: {
  target: AssistantForkTarget;
  boundary: AssistantTurnForkBoundary;
}) => Promise<void> | void;
/**
 * Fork handler for the turn that is still streaming. It deliberately takes no
 * boundary: `selectForkContextRows` projects the entire timeline when neither
 * boundary field is given, which is what captures the partially streamed text
 * the user is watching. Pinning a boundary here would silently drop the live
 * response — the opposite of what a fork button next to the loader promises.
 *
 * Kept separate from `AssistantTurnForkHandler` (whose `boundary` stays
 * required) so the compiler keeps enforcing that completed turns always pin one.
 */
export type InFlightTurnForkHandler = (target: AssistantForkTarget) => Promise<void> | void;

export const TurnFooter = memo(function TurnFooter({
  isRunning,
  inFlightTurnStartedAt,
  workingKind,
  workingLabel,
  host,
  strategy,
  onForkAssistantTurn,
  onForkInFlightTurn,
}: {
  isRunning: boolean;
  inFlightTurnStartedAt: Date | null;
  workingKind: WorkingStatusKind;
  workingLabel: string;
  host: TurnFooterHost | null;
  strategy: TurnContentStrategy;
  onForkAssistantTurn?: AssistantTurnForkHandler;
  onForkInFlightTurn?: InFlightTurnForkHandler;
}) {
  if (isRunning) {
    return (
      <TurnFooterRow>
        <RunningTurnFooter
          inFlightTurnStartedAt={inFlightTurnStartedAt}
          workingKind={workingKind}
          workingLabel={workingLabel}
          onForkInFlightTurn={onForkInFlightTurn}
        />
      </TurnFooterRow>
    );
  }
  if (!host) {
    return null;
  }
  return (
    <CompletedTurnFooterRow
      strategy={strategy}
      items={host.items}
      timing={host.timing}
      startIndex={host.startIndex}
      onForkAssistantTurn={onForkAssistantTurn}
    />
  );
});

export const CompletedTurnFooterRow = memo(function CompletedTurnFooterRow({
  strategy,
  items,
  timing,
  startIndex,
  onForkAssistantTurn,
}: {
  strategy: TurnContentStrategy;
  items: StreamItem[];
  timing?: TurnTiming;
  startIndex: number;
  onForkAssistantTurn?: AssistantTurnForkHandler;
}) {
  return (
    <TurnFooterRow>
      <CompletedTurnFooter
        strategy={strategy}
        items={items}
        timing={timing}
        startIndex={startIndex}
        onForkAssistantTurn={onForkAssistantTurn}
      />
    </TurnFooterRow>
  );
});

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
      style={stylesheet.workingElapsed}
      testID="turn-working-elapsed"
    />
  );
}

const WorkingIndicator = memo(function WorkingIndicator({
  inFlightTurnStartedAt = null,
  workingKind,
  workingLabel,
  onForkInFlightTurn,
}: {
  inFlightTurnStartedAt?: Date | null;
  workingKind: WorkingStatusKind;
  workingLabel: string;
  onForkInFlightTurn?: InFlightTurnForkHandler;
}) {
  const active = useRetainedPanelActive();
  return (
    <View style={stylesheet.turnFooterContent}>
      <View style={stylesheet.workingLoader}>
        <ThemedWorkingPimi
          size={18}
          waiting={workingKind === "waiting"}
          uniProps={workingKind === "waiting" ? waitingPimiColorMapping : workingPimiColorMapping}
        />
      </View>
      <Text style={stylesheet.workingLabel} numberOfLines={1} testID="turn-working-label">
        {workingLabel}
      </Text>
      {/* Match the completed-turn footer: actions precede timing metadata. */}
      {onForkInFlightTurn ? <AssistantForkMenu onFork={onForkInFlightTurn} /> : null}
      {inFlightTurnStartedAt ? (
        <DelayedElapsed startedAt={inFlightTurnStartedAt} active={active} />
      ) : null}
    </View>
  );
});

function RunningTurnFooter({
  inFlightTurnStartedAt,
  workingKind,
  workingLabel,
  onForkInFlightTurn,
}: {
  inFlightTurnStartedAt: Date | null;
  workingKind: WorkingStatusKind;
  workingLabel: string;
  onForkInFlightTurn?: InFlightTurnForkHandler;
}) {
  return (
    <View style={stylesheet.turnFooterSlot} testID="turn-working-indicator">
      <WorkingIndicator
        inFlightTurnStartedAt={inFlightTurnStartedAt}
        workingKind={workingKind}
        workingLabel={workingLabel}
        onForkInFlightTurn={onForkInFlightTurn}
      />
    </View>
  );
}

function CompletedTurnFooter({
  strategy,
  items,
  timing,
  startIndex,
  onForkAssistantTurn,
}: {
  strategy: TurnContentStrategy;
  items: StreamItem[];
  timing?: TurnTiming;
  startIndex: number;
  onForkAssistantTurn?: AssistantTurnForkHandler;
}) {
  const getContent = useCallback(
    () =>
      collectAssistantResponseContentForStreamRenderStrategy({
        strategy,
        items,
        startIndex,
      }),
    [strategy, items, startIndex],
  );
  const boundary = resolveAssistantTurnForkBoundary({
    items,
    startIndex,
  });
  const handleFork = useCallback(
    (target: AssistantForkTarget) => {
      if (!boundary) {
        return;
      }
      return onForkAssistantTurn?.({ target, boundary });
    },
    [boundary, onForkAssistantTurn],
  );
  return (
    <View style={stylesheet.turnFooterSlot}>
      <AssistantTurnFooter
        getContent={items[startIndex]?.kind === "assistant_message" ? getContent : undefined}
        completedAt={timing?.completedAt}
        durationMs={timing?.durationMs}
        onFork={boundary && onForkAssistantTurn ? handleFork : undefined}
      />
    </View>
  );
}

function TurnFooterRow({ children }: { children: ReactNode }) {
  const rowStyle = useMemo(() => [stylesheet.streamItemWrapper, stylesheet.turnFooterRow], []);
  return (
    <View style={rowStyle} testID="turn-footer">
      {children}
    </View>
  );
}

const stylesheet = StyleSheet.create((theme) => ({
  streamItemWrapper: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[2],
  },
  // The message above drops its bottom padding for the footer (compactBottom), so this margin
  // alone sets the gap. 20 puts the footer as far below the text as the text sits below a
  // tool row: 12 message padding + 4 stream gap + 5 badge padding/border, less the footer's
  // 1px taller row.
  turnFooterRow: {
    marginTop: theme.spacing[4] + theme.spacing[1],
  },
  turnFooterSlot: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    maxWidth: "100%",
    height: TURN_FOOTER_CONTENT_HEIGHT + TURN_FOOTER_BOTTOM_SPACING,
    paddingBottom: TURN_FOOTER_BOTTOM_SPACING,
  },
  turnFooterContent: {
    height: TURN_FOOTER_CONTENT_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    flexShrink: 1,
    gap: theme.spacing[3],
  },
  workingElapsed: {
    color: theme.colors.foregroundMuted,
    fontSize: STREAM_METADATA_FONT_SIZE,
    fontVariant: ["tabular-nums"],
  },
  workingLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: STREAM_METADATA_FONT_SIZE,
    flexShrink: 1,
  },
  workingLoader: {
    marginLeft: -2,
  },
}));
