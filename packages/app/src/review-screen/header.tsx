// Pimi. PolyForm-Noncommercial-1.0.0.
// Stream S2 owns this file: the top bar (back/forward, Pull requests / Worktrees) and the detail
// header (repo and number, title, state/branch/counter chips, Overview / Changes tabs).
import { i18n } from "@/i18n/i18next";
import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "@/i18n/use-translation";
import { DiffStat } from "@/components/diff-stat";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { StatusBadge } from "@/components/ui/status-badge";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useFetchQuery } from "@/data/query";
import { getHostRuntimeStore, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { ChecksChip, DecisionChip, StateChip } from "./chips";
import type {
  ChangeRequestSource,
  ReviewDetailHeaderProps,
  ReviewDetailTab,
  ReviewHeaderProps,
  ReviewMode,
} from "./types";

const ThemedChevronLeft = withUnistyles(ChevronLeft);
const ThemedChevronRight = withUnistyles(ChevronRight);
const iconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function ReviewHeader({ mode, navigation, onModeChange }: ReviewHeaderProps) {
  const { t } = useTranslation();
  const options = useMemo<SegmentedControlOption<ReviewMode>[]>(
    () => [
      {
        value: "pull_requests",
        label: t("reviewScreen.pullRequests"),
        testID: "review-mode-prs",
      },
      {
        value: "worktrees",
        label: t("reviewScreen.worktrees"),
        testID: "review-mode-worktrees",
      },
    ],
    [t],
  );
  return (
    <View
      style={styles.bar}
      testID="review-header"
      role="group"
      accessibilityLabel={t("reviewScreen.historyLabel")}
    >
      <View style={styles.history}>
        <ToolbarButton
          label={t("reviewScreen.backLabel")}
          onPress={navigation.goBack}
          disabled={!navigation.canGoBack}
          testID="review-back"
        >
          <ThemedChevronLeft size={16} uniProps={iconMapping} />
        </ToolbarButton>
        <ToolbarButton
          label={t("reviewScreen.forwardLabel")}
          onPress={navigation.goForward}
          disabled={!navigation.canGoForward}
          testID="review-forward"
        >
          <ThemedChevronRight size={16} uniProps={iconMapping} />
        </ToolbarButton>
      </View>
      <SegmentedControl
        options={options}
        value={mode}
        onValueChange={onModeChange}
        size="sm"
        appearance="track"
        accessibilityLabel={t("reviewScreen.sourceLabel")}
        testID="review-mode"
      />
    </View>
  );
}

function useOverview(source: ChangeRequestSource | null) {
  const connected = useHostRuntimeIsConnected(source?.serverId ?? "");
  const query = useFetchQuery({
    queryKey: [
      "review-screen",
      "overview-header",
      source?.serverId,
      source?.forgeHost,
      source?.owner,
      source?.name,
      source?.number,
    ],
    enabled: source !== null && connected,
    dataShape: "value",
    staleTimeMs: 30_000,
    queryFn: async () => {
      const client = source ? getHostRuntimeStore().getClient(source.serverId) : null;
      if (!source || !client) throw new Error(i18n.t("reviewScreen.errors.hostNotConnected"));
      return client.forgeChangeRequestGetOverview({
        forgeHost: source.forgeHost,
        owner: source.owner,
        name: source.name,
        number: source.number,
      });
    },
  });
  return query;
}

export function ReviewDetailHeader({ source, tab, onTabChange }: ReviewDetailHeaderProps) {
  const { t } = useTranslation();
  const changeRequest = source.kind === "change_request" ? source : null;
  const overviewQuery = useOverview(changeRequest);
  const overview = overviewQuery.data?.overview ?? null;

  const identity = changeRequest
    ? `${changeRequest.owner}/${changeRequest.name} #${changeRequest.number}`
    : t("reviewScreen.worktree");
  let title: string;
  if (source.kind === "checkout") {
    title =
      source.cwd
        .replace(/[\\/]+$/, "")
        .split(/[\\/]/)
        .pop() || source.cwd;
  } else {
    if (overview) title = overview.title;
    else if (overviewQuery.isPending) title = t("reviewScreen.loading");
    else title = t("reviewScreen.detailFailed");
  }

  return (
    <View style={styles.detailTop} testID="review-detail-header">
      <Text style={styles.identity} numberOfLines={1}>
        {identity}
      </Text>
      <Text style={styles.title} numberOfLines={2} testID="review-detail-title">
        {title}
      </Text>
      <View style={styles.meta}>
        {overview ? (
          <>
            <StateChip state={overview.state} isDraft={overview.isDraft} />
            <StatusBadge
              variant="muted"
              label={`${overview.headRefName} → ${overview.baseRefName}`}
            />
            <ChecksChip status={overview.checksStatus} />
            <DecisionChip decision={overview.reviewDecision} />
            {overview.mergeable === "CONFLICTING" ? (
              <StatusBadge variant="warning" label={t("reviewScreen.conflicts")} />
            ) : null}
            <Text style={styles.metaText}>
              {t("reviewScreen.filesCount", { count: overview.changedFiles })}
            </Text>
            <DiffStat additions={overview.additions} deletions={overview.deletions} />
          </>
        ) : null}
        {source.kind === "checkout" ? (
          <StatusBadge variant="muted" label={compareLabel(source.compare.mode, t)} />
        ) : null}
      </View>
      <View style={styles.tabs} role="tablist" accessibilityLabel={t("reviewScreen.tabsLabel")}>
        <DetailTab
          tab="overview"
          selected={tab === "overview"}
          label={t("reviewScreen.tabOverview")}
          onPress={onTabChange}
        />
        <DetailTab
          tab="changes"
          selected={tab === "changes"}
          label={t("reviewScreen.tabChanges")}
          onPress={onTabChange}
        />
      </View>
    </View>
  );
}

function compareLabel(mode: "uncommitted" | "base" | "all", t: (key: string) => string): string {
  if (mode === "uncommitted") return t("reviewScreen.compareUncommitted");
  if (mode === "base") return t("reviewScreen.compareBase");
  return t("reviewScreen.compareAll");
}

function DetailTab({
  tab,
  selected,
  label,
  onPress,
}: {
  tab: ReviewDetailTab;
  selected: boolean;
  label: string;
  onPress: (tab: ReviewDetailTab) => void;
}) {
  const state = useMemo(() => ({ selected }), [selected]);
  const handlePress = useCallback(() => onPress(tab), [onPress, tab]);
  return (
    <PressHighlight
      onPress={handlePress}
      role="tab"
      accessibilityState={state}
      accessibilityLabel={label}
      style={selected ? styles.tabSelected : styles.tab}
      testID={`review-tab-${tab}`}
    >
      <Text style={selected ? styles.tabTextSelected : styles.tabText}>{label}</Text>
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  history: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  detailTop: {
    gap: theme.spacing[2],
    paddingTop: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  identity: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.normal,
  },
  meta: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  metaText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  tabs: {
    flexDirection: "row",
    gap: theme.spacing[6],
    marginTop: theme.spacing[1],
  },
  tab: {
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabSelected: {
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 2,
    borderBottomColor: theme.colors.accent,
  },
  tabText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  tabTextSelected: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
}));
