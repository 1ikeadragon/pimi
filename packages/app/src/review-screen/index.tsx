// Pimi. Apache-2.0.
// Review screen shell, modelled on the website's Review mockup: a top bar, a left rail of change
// requests, and a detail pane with Overview (stacked cards, a separate Checks card) and Changes
// (file tree + diff + collapsible Threads/Checks inspector) tabs. The shell owns layout, history,
// the shared selection and desk focus; every pane is a slot owned by one stream (see each file's
// header). Add behaviour in the slot, not here.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { useIsCompactFormFactor } from "@/constants/layout";
import { ReviewFixSheet } from "./agent-actions/fix-sheet";
import { ReviewDesk } from "./desk";
import { ReviewDetailHeader, ReviewHeader } from "./header";
import { ReviewInspector } from "./inspector";
import { ReviewOverview } from "./overview";
import { ReviewRail } from "./rail";
import {
  EMPTY_REVIEW_SELECTION,
  type ReviewDetailTab,
  type ReviewInspectorTab,
  type ReviewJumpTo,
  type ReviewMode,
  type ReviewNavigation,
  type ReviewSelection,
  type ReviewSource,
} from "./types";
import { useReviewHistory } from "./use-review-history";

const PIMI_BACKGROUND = { "pimi-background": "" };

export function ReviewScreen({
  source: routeSource,
  serverId,
}: {
  /** The change request or worktree named by the route, or null for the bare rail. */
  source: ReviewSource | null;
  /** Daemon the rail reads through; null while no host is connected. */
  serverId: string | null;
}) {
  const { current, navigation } = useReviewHistory({
    mode: routeSource?.kind === "checkout" ? "worktrees" : "pull_requests",
    source: routeSource,
    tab: "overview",
    path: null,
  });
  const { push } = navigation;
  // A route change (sidebar link, chat card) opens that review as a new history entry.
  const routeKey = routeSource ? JSON.stringify(routeSource) : null;
  useEffect(() => {
    if (routeSource) {
      push({
        mode: routeSource.kind === "checkout" ? "worktrees" : "pull_requests",
        source: routeSource,
        tab: "overview",
        path: null,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the serialized source
  }, [routeKey, push]);

  const onModeChange = useCallback((mode: ReviewMode) => push({ mode, source: null }), [push]);
  const onOpen = useCallback(
    (next: ReviewSource) => push({ source: next, tab: "overview", path: null }),
    [push],
  );

  return (
    <View style={styles.screen} dataSet={PIMI_BACKGROUND} testID="pimi-review">
      <MenuHeader title="Review" />
      <ReviewHeader mode={current.mode} navigation={navigation} onModeChange={onModeChange} />
      <ReviewBody
        serverId={serverId}
        mode={current.mode}
        source={current.source}
        tab={current.tab}
        navigation={navigation}
        onOpen={onOpen}
      />
    </View>
  );
}

function ReviewBody({
  serverId,
  mode,
  source,
  tab,
  navigation,
  onOpen,
}: {
  serverId: string | null;
  mode: ReviewMode;
  source: ReviewSource | null;
  tab: ReviewDetailTab;
  navigation: ReviewNavigation;
  onOpen: (source: ReviewSource) => void;
}) {
  const isCompact = useIsCompactFormFactor();
  // Compact: the rail is its own page; opening a change request replaces it with the detail pane.
  const showRail = !isCompact || source === null;
  const rail = serverId ? (
    <ReviewRail serverId={serverId} mode={mode} selected={source} onOpen={onOpen} />
  ) : null;
  return (
    <View style={styles.body}>
      {showRail ? <View style={isCompact ? styles.railCompact : styles.rail}>{rail}</View> : null}
      {source ? (
        <ReviewDetail
          key={JSON.stringify(source)}
          source={source}
          tab={tab}
          navigation={navigation}
        />
      ) : null}
    </View>
  );
}

function ReviewDetail({
  source,
  tab,
  navigation,
}: {
  source: ReviewSource;
  tab: ReviewDetailTab;
  navigation: ReviewNavigation;
}) {
  const isCompact = useIsCompactFormFactor();
  const [inspectorTab, setInspectorTab] = useState<ReviewInspectorTab>("threads");
  const [selection, setSelection] = useState<ReviewSelection>(EMPTY_REVIEW_SELECTION);
  const [focus, setFocus] = useState<{ path: string; line: number | null; nonce: number } | null>(
    null,
  );
  const [fixOpen, setFixOpen] = useState(false);
  const { push } = navigation;

  const closeFixSheet = useCallback(() => setFixOpen(false), []);
  const onTabChange = useCallback((next: ReviewDetailTab) => push({ tab: next }), [push]);
  const onJumpTo = useCallback<ReviewJumpTo>(
    (path, line) => {
      setFocus((current) => ({ path, line, nonce: (current?.nonce ?? 0) + 1 }));
      push({ tab: "changes", path });
    },
    [push],
  );

  return (
    <View style={styles.detail}>
      <ReviewDetailHeader source={source} tab={tab} onTabChange={onTabChange} />
      {tab === "overview" ? (
        <ReviewOverview
          source={source}
          onJumpTo={onJumpTo}
          selection={selection}
          onSelectionChange={setSelection}
        />
      ) : (
        <View style={styles.changes}>
          <View style={styles.desk}>
            <ReviewDesk
              source={source}
              focus={focus}
              selection={selection}
              onSelectionChange={setSelection}
            />
          </View>
          {isCompact ? null : (
            <View style={styles.inspector}>
              <ReviewInspector
                source={source}
                tab={inspectorTab}
                onTabChange={setInspectorTab}
                onJumpTo={onJumpTo}
                selection={selection}
                onSelectionChange={setSelection}
              />
            </View>
          )}
        </View>
      )}
      <ReviewFixSheet
        source={source}
        selection={selection}
        visible={fixOpen}
        onClose={closeFixSheet}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, minWidth: 0, backgroundColor: theme.colors.surface0 },
  body: { flex: 1, minHeight: 0, flexDirection: "row" },
  rail: { width: 300, borderRightWidth: 1, borderRightColor: theme.colors.border },
  railCompact: { flex: 1 },
  detail: { flex: 1, minWidth: 0 },
  changes: { flex: 1, minHeight: 0, flexDirection: "row" },
  desk: { flex: 1, minWidth: 0 },
  inspector: { width: 340, borderLeftWidth: 1, borderLeftColor: theme.colors.border },
}));
