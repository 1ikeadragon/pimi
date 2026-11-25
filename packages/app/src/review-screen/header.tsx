// Pimi. PolyForm-Noncommercial-1.0.0.
// Review's chrome. `ReviewHomeBar` is the inbox's top bar (history, Pull requests / Worktrees,
// search, refresh). `ReviewDetailBar` replaces it while a source is open (history, breadcrumb back
// to the inbox, open on the forge, refresh). `ReviewDetailHeader` is the title block and tab row of
// a pull request or worktree page. None of them reads a query: the page owns the data.
import { useCallback, useMemo, type ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Link,
  MoreHorizontal,
  RefreshCw,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useQueryClient, useIsFetching } from "@tanstack/react-query";
import { useTranslation } from "@/i18n/use-translation";
import { Button } from "@/components/ui/button";
import { DiffStat } from "@/components/diff-stat";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SearchField } from "@/components/ui/search-field";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { SkeletonPulse, useSkeletonPulse } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { CheckPresentationIcon } from "@/git/check-presentation.view";
import { useToast } from "@/contexts/toast-context";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import { openExternalUrl } from "@/utils/open-external-url";
import { StateChip } from "./chips";
import { reviewKeys, markInboxRefresh, type ChangeRequestOverview } from "./queries";
import type {
  ChangeRequestSource,
  CheckoutSource,
  ReviewDetailTab,
  ReviewMode,
  ReviewNavigation,
  ReviewSource,
} from "./types";
import type { InboxItem } from "./use-inbox";
import {
  useCheckoutChangeRequest,
  type ReviewCheckSection,
  type ReviewTimeline,
} from "./use-review-timeline";
import { useCheckoutStatusQuery } from "@/git/use-status-query";
import { useCheckoutDiff } from "./desk/use-files-model";
import { prefetchChangeRequest } from "./queries";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

const ThemedChevronLeft = withUnistyles(ChevronLeft);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedRefresh = withUnistyles(RefreshCw);
const ThemedMore = withUnistyles(MoreHorizontal);
const ThemedExternalLink = withUnistyles(ExternalLink);
const ThemedLink = withUnistyles(Link);
const ThemedSpinner = withUnistyles(LoadingSpinner);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const OPEN_ICON = <ThemedExternalLink size={14} uniProps={mutedMapping} />;
const LINK_ICON = <ThemedLink size={14} uniProps={mutedMapping} />;
const REFRESH_ICON = <ThemedRefresh size={14} uniProps={mutedMapping} />;

const SEARCH_WIDTH = 320;

function HistoryButtons({ navigation }: { navigation: ReviewNavigation }) {
  const { t } = useTranslation();
  return (
    <View
      style={styles.history}
      testID="review-header"
      role="group"
      accessibilityLabel={t("reviewScreen.historyLabel")}
    >
      <ToolbarButton
        label={t("reviewScreen.backLabel")}
        onPress={navigation.goBack}
        disabled={!navigation.canGoBack}
        testID="review-back"
      >
        <ThemedChevronLeft size={16} uniProps={mutedMapping} />
      </ToolbarButton>
      <ToolbarButton
        label={t("reviewScreen.forwardLabel")}
        onPress={navigation.goForward}
        disabled={!navigation.canGoForward}
        testID="review-forward"
      >
        <ThemedChevronRight size={16} uniProps={mutedMapping} />
      </ToolbarButton>
    </View>
  );
}

function RefreshButton({
  onPress,
  spinning,
  disabled,
  testID,
}: {
  onPress: () => void;
  spinning: boolean;
  disabled?: boolean;
  testID: string;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.refresh}>
      {spinning ? <ThemedSpinner size={14} uniProps={mutedMapping} /> : null}
      <ToolbarButton
        label={t("reviewScreen.refresh")}
        onPress={onPress}
        disabled={disabled}
        testID={testID}
      >
        <ThemedRefresh size={14} uniProps={mutedMapping} />
      </ToolbarButton>
    </View>
  );
}

export function ReviewHomeBar({
  serverId,
  connected,
  mode,
  navigation,
  onModeChange,
  query,
  onQueryChange,
}: {
  serverId: string | null;
  connected: boolean;
  mode: ReviewMode;
  navigation: ReviewNavigation;
  onModeChange: (mode: ReviewMode) => void;
  query: string;
  onQueryChange: (query: string) => void;
}) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const queryClient = useQueryClient();
  const fetching =
    useIsFetching({ queryKey: reviewKeys.inbox(serverId ?? "") }) > 0 && mode === "pull_requests";
  const refresh = useCallback(() => {
    if (!serverId) return;
    markInboxRefresh(serverId);
    void queryClient.invalidateQueries({ queryKey: reviewKeys.inbox(serverId) });
  }, [queryClient, serverId]);
  const options = useMemo<SegmentedControlOption<ReviewMode>[]>(
    () => [
      { value: "pull_requests", label: t("reviewScreen.pullRequests"), testID: "review-mode-prs" },
      { value: "worktrees", label: t("reviewScreen.worktrees"), testID: "review-mode-worktrees" },
    ],
    [t],
  );
  const modeSwitch = (
    <SegmentedControl
      options={options}
      value={mode}
      onValueChange={onModeChange}
      size="sm"
      appearance="track"
      accessibilityLabel={t("reviewScreen.sourceLabel")}
      testID="review-mode"
    />
  );
  const search = (
    <SearchField
      value={query}
      onChangeText={onQueryChange}
      placeholder={
        mode === "pull_requests"
          ? t("reviewScreen.searchPullRequests")
          : t("reviewScreen.searchWorktrees")
      }
      clearAccessibilityLabel={t("reviewScreen.clearSearch")}
      testID="review-inbox-search"
    />
  );
  const refreshButton =
    mode === "pull_requests" ? (
      <RefreshButton
        onPress={refresh}
        spinning={fetching}
        disabled={!connected}
        testID="review-inbox-refresh"
      />
    ) : null;
  if (isCompact) {
    return (
      <View style={styles.homeBarCompact} testID="review-home-bar">
        <View style={styles.row}>
          {modeSwitch}
          <View style={styles.spacer} />
          {refreshButton}
        </View>
        {search}
      </View>
    );
  }
  return (
    <View style={styles.homeBar} testID="review-home-bar">
      <HistoryButtons navigation={navigation} />
      {modeSwitch}
      <View style={styles.spacer} />
      <View style={styles.searchWrap}>{search}</View>
      {refreshButton}
    </View>
  );
}

export function ReviewDetailBar({
  source,
  identity,
  navigation,
  onHome,
  url,
  brandLabel,
  onRefresh,
  refreshing,
}: {
  source: ReviewSource;
  /** `owner/name #n` for a pull request, the workspace name for a worktree. */
  identity: string;
  navigation: ReviewNavigation;
  onHome: () => void;
  /** The pull request's page on its forge, once the overview has answered. */
  url: string | null;
  brandLabel: string;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const toast = useToast();
  const homeLabel =
    source.kind === "change_request" ? t("reviewScreen.pullRequests") : t("reviewScreen.worktrees");
  const openOnForge = useCallback(() => {
    if (url) void openExternalUrl(url);
  }, [url]);
  const copyLink = useCallback(() => {
    if (!url) return;
    void Clipboard.setStringAsync(url).then(
      () => toast.copied(t("reviewScreen.link")),
      () => toast.error(t("common.errors.unableToCopy")),
    );
  }, [t, toast, url]);

  if (isCompact) {
    return (
      <View style={styles.detailBarCompact} testID="review-detail-bar">
        <ToolbarButton label={homeLabel} onPress={onHome} testID="review-home">
          <ThemedChevronLeft size={16} uniProps={mutedMapping} />
        </ToolbarButton>
        <Text style={styles.identity} numberOfLines={1}>
          {identity}
        </Text>
        <View style={styles.spacer} />
        {refreshing ? <ThemedSpinner size={14} uniProps={mutedMapping} /> : null}
        <DropdownMenu>
          <DropdownMenuTrigger
            hitSlop={8}
            accessibilityLabel={t("reviewScreen.moreActions")}
            style={styles.menuTrigger}
            testID="review-detail-menu"
          >
            <ThemedMore size={16} uniProps={mutedMapping} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" width={220}>
            {url ? (
              <DropdownMenuItem leading={OPEN_ICON} onSelect={openOnForge}>
                {t("reviewScreen.openOn", { brand: brandLabel })}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem leading={REFRESH_ICON} onSelect={onRefresh}>
              {t("reviewScreen.refresh")}
            </DropdownMenuItem>
            {url ? (
              <DropdownMenuItem leading={LINK_ICON} onSelect={copyLink}>
                {t("reviewScreen.copyLink")}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </View>
    );
  }
  return (
    <View style={styles.homeBar} testID="review-detail-bar">
      <HistoryButtons navigation={navigation} />
      <View style={styles.breadcrumb}>
        <PressHighlight
          onPress={onHome}
          accessibilityRole="link"
          style={styles.crumbHome}
          testID="review-home"
        >
          <Text style={styles.crumbText}>{homeLabel}</Text>
        </PressHighlight>
        <Text style={styles.crumbText}>/</Text>
        <Text style={styles.identity} numberOfLines={1}>
          {identity}
        </Text>
      </View>
      {url ? (
        <Button size="sm" variant="ghost" onPress={openOnForge} testID="review-open-on-forge">
          {t("reviewScreen.openOn", { brand: brandLabel })}
        </Button>
      ) : null}
      <RefreshButton onPress={onRefresh} spinning={refreshing} testID="review-detail-refresh" />
    </View>
  );
}

// ---- worktree header ----

export interface WorktreeHeader {
  /** The requested source, with a base compare turned into uncommitted when there is no base. */
  source: CheckoutSource;
  title: string;
  branch: string | null;
  baseRef: string | null;
  /** From the loaded diff; null until it has arrived. */
  stat: { additions: number; deletions: number; files: number } | null;
  /** The pull request the checked-out branch has, if it has one. */
  pullRequest: ChangeRequestSource | null;
}

export function worktreeNameOf(cwd: string): string {
  return (
    cwd
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || cwd
  );
}

function useWorktreeSource(requestedSource: CheckoutSource | null): {
  source: CheckoutSource | null;
  branch: string | null;
  baseRef: string | null;
} {
  const { status } = useCheckoutStatusQuery({
    serverId: requestedSource?.serverId ?? "",
    cwd: requestedSource?.cwd ?? "",
  });
  const knownStatus = status && status.isGit ? status : null;
  const currentBranch = knownStatus?.currentBranch;
  const branch = currentBranch && currentBranch !== "HEAD" ? currentBranch : null;
  const rawBase = knownStatus?.baseRef ?? requestedSource?.compare.baseRef;
  const comparisonRef = rawBase?.replace(/^refs\/(?:heads|remotes)\//, "") ?? null;
  // A branch compared with itself has no base to show or to diff against.
  const baseRef = comparisonRef && comparisonRef !== branch ? comparisonRef : null;
  const statusKnown = knownStatus !== null;
  // Without a base the base compare is empty and the control has no option to select it.
  const source = useMemo<CheckoutSource | null>(
    () =>
      requestedSource && statusKnown && baseRef === null && requestedSource.compare.mode === "base"
        ? { ...requestedSource, compare: { ...requestedSource.compare, mode: "uncommitted" } }
        : requestedSource,
    [baseRef, requestedSource, statusKnown],
  );
  return { source, branch, baseRef };
}

/** What a worktree page's header shows: all of it reads caches the Files tab fills. */
export function useWorktreeHeader(requestedSource: CheckoutSource | null): WorktreeHeader | null {
  const { source, branch, baseRef } = useWorktreeSource(requestedSource);
  const { workspace, diff } = useCheckoutDiff(source);
  const { ref } = useCheckoutChangeRequest(source);
  const stat = useMemo(() => {
    if (diff.isLoading || diff.payloadError) return null;
    let additions = 0;
    let deletions = 0;
    for (const file of diff.files) {
      additions += file.additions;
      deletions += file.deletions;
    }
    return { additions, deletions, files: diff.files.length };
  }, [diff.files, diff.isLoading, diff.payloadError]);
  if (!source) return null;
  return {
    source,
    title: workspace?.title || workspace?.name || worktreeNameOf(source.cwd),
    branch,
    baseRef,
    stat,
    pullRequest: ref,
  };
}

export function ReviewWorktreeHeader({
  source,
  worktree,
  onCompareChange,
  onOpenPullRequest,
}: {
  source: CheckoutSource;
  worktree: WorktreeHeader;
  onCompareChange: (mode: CheckoutSource["compare"]["mode"]) => void;
  onOpenPullRequest: (ref: ChangeRequestSource) => void;
}) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const hasBase = worktree.baseRef !== null;
  const options = useMemo<SegmentedControlOption<CheckoutSource["compare"]["mode"]>[]>(
    () => [
      {
        value: "uncommitted",
        label: t("reviewScreen.compareUncommitted"),
        testID: "review-compare-uncommitted",
      },
      ...(hasBase
        ? [
            {
              value: "base" as const,
              label: t("reviewScreen.compareBase"),
              testID: "review-compare-base",
            },
          ]
        : []),
      { value: "all", label: t("reviewScreen.compareAll"), testID: "review-compare-all" },
    ],
    [hasBase, t],
  );
  const queryClient = useQueryClient();
  const pullRequest = worktree.pullRequest;
  const openPullRequest = useCallback(() => {
    if (!pullRequest) return;
    prefetchChangeRequest(
      queryClient,
      getHostRuntimeStore().getClient(pullRequest.serverId),
      pullRequest,
    );
    onOpenPullRequest(pullRequest);
  }, [onOpenPullRequest, pullRequest, queryClient]);
  const tabs: DetailTabSpec[] = [
    {
      tab: "files",
      label: t("reviewScreen.tabFiles"),
      count: worktree.stat ? String(worktree.stat.files) : "",
    },
  ];
  const branches =
    worktree.branch && worktree.baseRef
      ? `${worktree.branch} → ${worktree.baseRef}`
      : worktree.branch;
  const noop = useCallback(() => {}, []);
  return (
    <View style={isCompact ? styles.headerCompact : styles.header} testID="review-detail-header">
      <Text style={styles.title} numberOfLines={2} testID="review-detail-title">
        {worktree.title}
      </Text>
      <View style={styles.worktreeMeta}>
        <View style={styles.metaRow}>
          {branches ? (
            <Text style={styles.sentenceText} numberOfLines={1}>
              {branches}
            </Text>
          ) : (
            <View style={styles.spacer} />
          )}
          {pullRequest ? (
            <PressHighlight
              onPress={openPullRequest}
              accessibilityRole="link"
              style={styles.prChip}
              testID="review-worktree-pr"
            >
              <StatusBadge
                variant="success"
                size="xs"
                label={t("reviewScreen.pullRequestChip", { number: pullRequest.number })}
              />
            </PressHighlight>
          ) : null}
        </View>
        <View style={styles.metaRow}>
          <SegmentedControl
            options={options}
            value={source.compare.mode}
            onValueChange={onCompareChange}
            size="sm"
            appearance="track"
            accessibilityLabel={t("reviewScreen.compareLabel")}
            testID="review-compare"
          />
          <View style={styles.spacer} />
          <View style={styles.diffstat}>
            {worktree.stat ? (
              <DiffStat additions={worktree.stat.additions} deletions={worktree.stat.deletions} />
            ) : null}
          </View>
        </View>
      </View>
      <TabRow tabs={tabs} tab="files" onTabChange={noop} scrollable={false} />
    </View>
  );
}

// ---- detail header ----

type Head = Pick<
  InboxItem,
  "state" | "isDraft" | "title" | "author" | "headRefName" | "baseRefName"
>;

interface DetailTabSpec {
  tab: ReviewDetailTab;
  label: string;
  count?: ReactNode;
}

function worstCheckSection(sections: readonly ReviewCheckSection[]) {
  const attention = sections.find((section) => section.id === "attention");
  if (attention) return { presentation: "failure" as const, count: attention.count };
  if (sections.some((section) => section.id === "running")) {
    return { presentation: "pending" as const, count: 0 };
  }
  if (sections.length > 0) return { presentation: "success" as const, count: 0 };
  return null;
}

export function ReviewPullRequestHeader({
  tab,
  onTabChange,
  timeline,
  seed,
  trailing,
}: {
  tab: ReviewDetailTab;
  onTabChange: (tab: ReviewDetailTab) => void;
  timeline: ReviewTimeline;
  /** The end of the tab row: the Review changes button on a wide screen. */
  trailing?: ReactNode;
  /** The inbox row this page was opened from; fills the header until the overview answers. */
  seed: InboxItem | null;
}) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const overview = timeline.overview;
  const head: Head | null = overview ?? seed;

  const tabs: DetailTabSpec[] = [
    {
      tab: "conversation",
      label: t("reviewScreen.tabConversation"),
      count: timeline.threadsLoading ? "" : String(commentCount(timeline)),
    },
    {
      tab: "commits",
      label: t("reviewScreen.tabCommits"),
      count: overview ? String(overview.commitCount) : "",
    },
    {
      tab: "checks",
      label: t("reviewScreen.tabChecks"),
      count: <ChecksTabCount loading={timeline.checksLoading} sections={timeline.checkSections} />,
    },
    {
      tab: "files",
      label: t("reviewScreen.tabFiles"),
      count: overview ? String(overview.changedFiles) : "",
    },
  ];

  return (
    <View style={isCompact ? styles.headerCompact : styles.header} testID="review-detail-header">
      <HeaderTitle head={head} failed={timeline.error !== null && !head} />
      <HeaderMetaOrSkeleton head={head} overview={overview} />
      <TabRow
        tabs={tabs}
        tab={tab}
        onTabChange={onTabChange}
        scrollable={isCompact}
        trailing={trailing}
      />
    </View>
  );
}

function commentCount(timeline: ReviewTimeline): number {
  let count = 0;
  for (const entry of timeline.entries) {
    if (entry.kind === "single") count += 1;
    else if (entry.kind === "thread") count += entry.comments.length;
    else count += 1 + entry.threads.reduce((sum, thread) => sum + thread.comments.length, 0);
  }
  return count;
}

function HeaderTitle({ head, failed }: { head: Head | null; failed: boolean }) {
  const { t } = useTranslation();
  const pulse = useSkeletonPulse();
  if (head) {
    return (
      <Text style={styles.title} numberOfLines={2} testID="review-detail-title">
        {head.title}
      </Text>
    );
  }
  if (failed) {
    return (
      <Text style={styles.title} numberOfLines={2} testID="review-detail-title">
        {t("reviewScreen.detailFailed")}
      </Text>
    );
  }
  return (
    <View style={styles.titleSkeletonBox} testID="review-detail-title">
      <SkeletonPulse pulse={pulse} style={styles.titleSkeleton} />
    </View>
  );
}

function HeaderMetaOrSkeleton({
  head,
  overview,
}: {
  head: Head | null;
  overview: ChangeRequestOverview | null;
}) {
  if (head) return <HeaderMeta head={head} overview={overview} />;
  return (
    <View style={styles.metaRow}>
      <HeaderMetaSkeleton />
    </View>
  );
}

function HeaderMetaSkeleton() {
  const pulse = useSkeletonPulse();
  return <SkeletonPulse pulse={pulse} style={styles.metaSkeleton} />;
}

function HeaderMeta({ head, overview }: { head: Head; overview: ChangeRequestOverview | null }) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const commits = overview?.commitCount;
  const branches = head.headRefName && head.baseRefName;
  const diffstat = (
    <View style={styles.diffstat}>
      {overview ? (
        <>
          <DiffStat additions={overview.additions} deletions={overview.deletions} />
          <Text style={styles.metaText}>
            {` · ${t("reviewScreen.filesCount", { count: overview.changedFiles })}`}
          </Text>
        </>
      ) : null}
    </View>
  );
  const conflicts =
    overview?.mergeable === "CONFLICTING" ? (
      <StatusBadge variant="warning" size="xs" label={t("reviewScreen.conflicts")} />
    ) : null;
  if (isCompact) {
    return (
      <View style={styles.metaCompact}>
        <View style={styles.metaRow}>
          <StateChip state={head.state} isDraft={head.isDraft} />
          <Text style={styles.sentenceText} numberOfLines={1}>
            {[head.author, branches ? `${head.headRefName} → ${head.baseRefName}` : null]
              .filter(Boolean)
              .join(" · ")}
          </Text>
          {conflicts}
        </View>
        {diffstat}
      </View>
    );
  }
  return (
    <View style={styles.metaRow}>
      <StateChip state={head.state} isDraft={head.isDraft} />
      <View style={styles.sentence}>
        {head.author ? (
          <Text style={styles.authorSentence} numberOfLines={1}>
            {commits !== undefined
              ? t("reviewScreen.wantsToMerge", { author: head.author, count: commits })
              : t("reviewScreen.openedBy", { author: head.author })}
          </Text>
        ) : null}
        {branches ? (
          <>
            <StatusBadge variant="muted" size="xs" label={head.baseRefName ?? ""} />
            <Text style={styles.metaText}>{t("reviewScreen.from")}</Text>
            <View style={styles.branchBadge}>
              <StatusBadge variant="muted" size="xs" label={shortBranch(head.headRefName ?? "")} />
            </View>
          </>
        ) : null}
        {conflicts}
      </View>
      {diffstat}
    </View>
  );
}

const BRANCH_LABEL_MAX = 48;

/** A 120-character branch name must not wrap the meta row (the header has a fixed height). */
function shortBranch(name: string): string {
  return name.length > BRANCH_LABEL_MAX ? `${name.slice(0, BRANCH_LABEL_MAX - 1)}…` : name;
}

function ChecksTabCount({
  loading,
  sections,
}: {
  loading: boolean;
  sections: readonly ReviewCheckSection[];
}) {
  if (loading) return null;
  const worst = worstCheckSection(sections);
  if (!worst) return null;
  return (
    <View style={styles.checksCount}>
      <CheckPresentationIcon presentation={worst.presentation} size={12} />
      {worst.count > 0 ? <Text style={styles.countText}>{worst.count}</Text> : null}
    </View>
  );
}

function TabRow({
  tabs,
  tab,
  onTabChange,
  scrollable,
  trailing,
}: {
  tabs: readonly DetailTabSpec[];
  tab: ReviewDetailTab;
  onTabChange: (tab: ReviewDetailTab) => void;
  scrollable: boolean;
  trailing?: ReactNode;
}) {
  const { t } = useTranslation();
  const row = (
    <View style={styles.tabs} role="tablist" accessibilityLabel={t("reviewScreen.tabsLabel")}>
      {tabs.map((spec) => (
        <DetailTab key={spec.tab} spec={spec} selected={tab === spec.tab} onPress={onTabChange} />
      ))}
    </View>
  );
  return (
    <View style={styles.tabRow}>
      {scrollable ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabScroll}>
          {row}
        </ScrollView>
      ) : (
        row
      )}
      {trailing ? <View style={styles.tabTrailing}>{trailing}</View> : null}
    </View>
  );
}

function DetailTab({
  spec,
  selected,
  onPress,
}: {
  spec: DetailTabSpec;
  selected: boolean;
  onPress: (tab: ReviewDetailTab) => void;
}) {
  const state = useMemo(() => ({ selected }), [selected]);
  const handlePress = useCallback(() => onPress(spec.tab), [onPress, spec.tab]);
  return (
    <PressHighlight
      onPress={handlePress}
      role="tab"
      accessibilityState={state}
      accessibilityLabel={spec.label}
      style={selected ? styles.tabSelected : styles.tab}
      testID={`review-tab-${spec.tab}`}
    >
      <Text style={selected ? styles.tabTextSelected : styles.tabText}>{spec.label}</Text>
      {spec.count !== undefined ? (
        <View style={styles.countSlot}>
          {typeof spec.count === "string" ? (
            <Text style={styles.countText}>{spec.count}</Text>
          ) : (
            spec.count
          )}
        </View>
      ) : null}
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  history: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  row: { flexDirection: "row", alignItems: "center", gap: theme.spacing[3] },
  spacer: { flex: 1 },
  refresh: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  homeBar: {
    // The height with the "Open on ..." button present, so it does not grow when the link arrives.
    minHeight: 45,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderWindow,
  },
  homeBarCompact: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderWindow,
  },
  searchWrap: { width: SEARCH_WIDTH, flexShrink: 1 },
  detailBarCompact: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderWindow,
  },
  menuTrigger: { padding: theme.spacing[1], borderRadius: theme.borderRadius.base },
  breadcrumb: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  crumbHome: { paddingVertical: theme.spacing[1], paddingHorizontal: theme.spacing[1] },
  crumbText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  identity: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  header: {
    paddingTop: theme.spacing[4],
    paddingHorizontal: theme.spacing[6],
    gap: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  headerCompact: {
    paddingTop: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    gap: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    lineHeight: 24,
    minHeight: 24,
  },
  titleSkeletonBox: { height: 24, justifyContent: "center" },
  titleSkeleton: {
    width: "45%",
    height: 14,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface3,
  },
  metaRow: {
    minHeight: 24,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  metaCompact: { gap: theme.spacing[1] },
  worktreeMeta: { gap: theme.spacing[2] },
  prChip: { borderRadius: theme.borderRadius.full },
  sentenceText: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  metaSkeleton: {
    width: "35%",
    height: 12,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface3,
  },
  sentence: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "nowrap",
    gap: theme.spacing[1.5],
    overflow: "hidden",
  },
  // The long branch name gives way first; the sentence and the base branch stay whole.
  authorSentence: {
    flexShrink: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  branchBadge: { flexShrink: 1, minWidth: 0, overflow: "hidden" },
  metaText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  diffstat: {
    minWidth: 120,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
  },
  tabRow: { flexDirection: "row", alignItems: "flex-end" },
  tabScroll: { flex: 1 },
  tabTrailing: {
    flexDirection: "row",
    alignItems: "center",
    marginLeft: theme.spacing[4],
    paddingBottom: theme.spacing[1],
  },
  tabs: { flexDirection: "row", gap: theme.spacing[6] },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabSelected: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 2,
    borderBottomColor: theme.colors.accent,
  },
  tabText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  tabTextSelected: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  countSlot: { minWidth: 20, alignItems: "flex-start", justifyContent: "center" },
  countText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  checksCount: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
}));
