import { LiveBackdrop } from "@/appearance/live/live-backdrop";
// Pimi. PolyForm-Noncommercial-1.0.0.
// Review screen shell, modelled on the website's Review mockup: a top bar, a left rail of change
// requests, and a detail pane with Overview (stacked cards, a separate Checks card) and Changes
// (file tree + diff + collapsible Threads/Checks inspector) tabs. The shell owns layout, history,
// the shared selection and desk focus; every pane is a slot owned by one stream (see each file's
// header). Add behaviour in the slot, not here.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "@/i18n/use-translation";
import { PanelRight } from "lucide-react-native";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { Text, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
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

  const { t } = useTranslation();
  const onModeChange = useCallback((mode: ReviewMode) => push({ mode, source: null }), [push]);
  const onOpen = useCallback(
    (next: ReviewSource) => push({ source: next, tab: "overview", path: null }),
    [push],
  );

  return (
    <View style={styles.screen} dataSet={PIMI_BACKGROUND} testID="pimi-review">
      <LiveBackdrop />
      <MenuHeader title={t("reviewScreen.title")} />
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
      {source || isCompact ? null : <NothingSelected mode={mode} />}
    </View>
  );
}

/** The detail pane before anything is chosen: say what to do, so it never reads as blank. */
function NothingSelected({ mode }: { mode: ReviewMode }) {
  const { t } = useTranslation();
  const worktrees = mode === "worktrees";
  return (
    <View style={styles.nothing} testID="review-nothing-selected">
      <Text style={styles.nothingTitle}>
        {t(worktrees ? "reviewScreen.selectWorktree" : "reviewScreen.selectPullRequest")}
      </Text>
      <Text style={styles.nothingHint}>
        {t(worktrees ? "reviewScreen.selectWorktreeHint" : "reviewScreen.selectPullRequestHint")}
      </Text>
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
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [changesWidth, setChangesWidth] = useState(0);
  const { push } = navigation;
  // Tree (280) + a usable diff + inspector (340) need room; below that the inspector is a toggle.
  const narrow = changesWidth > 0 && changesWidth < INSPECTOR_MIN_CHANGES_WIDTH;
  const showInspector = !isCompact && (!narrow || inspectorOpen);
  const onChangesLayout = useCallback(
    (event: LayoutChangeEvent) => setChangesWidth(event.nativeEvent.layout.width),
    [],
  );
  const toggleInspector = useCallback(() => setInspectorOpen((open) => !open), []);

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
        <View style={styles.changes} onLayout={onChangesLayout}>
          <View style={styles.desk}>
            <ReviewDesk
              source={source}
              focus={focus}
              selection={selection}
              onSelectionChange={setSelection}
            />
          </View>
          {!isCompact && narrow ? (
            <View style={styles.inspectorToggle}>
              <ToolbarButton
                label="Toggle threads panel"
                selected={inspectorOpen}
                onPress={toggleInspector}
                testID="review-inspector-toggle"
              >
                <ThemedPanelRight
                  size={16}
                  uniProps={inspectorOpen ? foregroundMapping : mutedMapping}
                />
              </ToolbarButton>
            </View>
          ) : null}
          {showInspector ? (
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
          ) : null}
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

const ThemedPanelRight = withUnistyles(PanelRight);
const foregroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const INSPECTOR_MIN_CHANGES_WIDTH = 960;

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, minWidth: 0, backgroundColor: theme.colors.surface0 },
  body: { flex: 1, minHeight: 0, flexDirection: "row" },
  rail: { width: 300, borderRightWidth: 1, borderRightColor: theme.colors.border },
  railCompact: { flex: 1 },
  detail: { flex: 1, minWidth: 0 },
  changes: { flex: 1, minHeight: 0, flexDirection: "row" },
  desk: { flex: 1, minWidth: 0, overflow: "hidden" },
  inspectorToggle: {
    width: 36,
    alignItems: "center",
    paddingTop: theme.spacing[3],
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
  },
  inspector: { width: 340, borderLeftWidth: 1, borderLeftColor: theme.colors.border },
  nothing: {
    flex: 1,
    minWidth: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[6],
  },
  nothingTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
  },
  nothingHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));
