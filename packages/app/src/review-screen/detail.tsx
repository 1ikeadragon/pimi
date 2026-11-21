// Pimi. PolyForm-Noncommercial-1.0.0.
// A pull request page or a worktree page: bar, header with tabs, and the tab body at full width.
// The pull request page owns the one read of the pull request (`useReviewTimeline`), the
// Fix-selected checks, the focus request a thread or check sends to the Files tab, and the Fix
// sheet. The worktree page is the Files tab alone, with a link to the branch's pull request.
import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { StyleSheet } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { getForgePresentation } from "@/git/forge";
import { checkoutPrStatusQueryKey, checkoutStatusQueryKey } from "@/git/query-keys";
import { ReviewFixSheet } from "./agent-actions/fix-sheet";
import { ReviewChecks } from "./checks";
import { ReviewCommits } from "./commits";
import { ReviewConversation } from "./conversation";
import { ReviewDesk } from "./desk";
import {
  ReviewDetailBar,
  ReviewPullRequestHeader,
  ReviewWorktreeHeader,
  useWorktreeHeader,
} from "./header";
import { invalidateChangeRequest, reviewKeys } from "./queries";
import {
  EMPTY_REVIEW_SELECTION,
  type ChangeRequestSource,
  type CheckoutSource,
  type ReviewDetailTab,
  type ReviewJumpTo,
  type ReviewNavigation,
  type ReviewSelection,
  type ReviewSource,
} from "./types";
import { useInboxSeed } from "./use-inbox";
import { useReviewTimeline } from "./use-review-timeline";
import { ReviewWriteProvider } from "./write/provider";
import { ReviewChangesButton, ReviewChangesSheet } from "./write/review-sheet";

export function ReviewDetail({
  source,
  tab,
  navigation,
  onHome,
}: {
  source: ReviewSource;
  tab: ReviewDetailTab;
  navigation: ReviewNavigation;
  onHome: () => void;
}) {
  return source.kind === "change_request" ? (
    <PullRequestPage source={source} tab={tab} navigation={navigation} onHome={onHome} />
  ) : (
    <WorktreePage source={source} navigation={navigation} onHome={onHome} />
  );
}

function PullRequestPage({
  source,
  tab,
  navigation,
  onHome,
}: {
  source: ChangeRequestSource;
  tab: ReviewDetailTab;
  navigation: ReviewNavigation;
  onHome: () => void;
}) {
  const isCompact = useIsCompactFormFactor();
  const timeline = useReviewTimeline(source);
  const seed = useInboxSeed(source);
  const [selection, setSelection] = useState<ReviewSelection>(EMPTY_REVIEW_SELECTION);
  const [focus, setFocus] = useState<{ path: string; line: number | null; nonce: number } | null>(
    null,
  );
  const [fixOpen, setFixOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const openReview = useCallback(() => setReviewOpen(true), []);
  const closeReview = useCallback(() => setReviewOpen(false), []);
  const headerButton = useMemo(
    () => (isCompact ? null : <ReviewChangesButton onPress={openReview} />),
    [isCompact, openReview],
  );
  const closeFixSheet = useCallback(() => setFixOpen(false), []);
  const { push } = navigation;

  const onTabChange = useCallback((next: ReviewDetailTab) => push({ tab: next }), [push]);
  const onOpenChecks = useCallback(() => push({ tab: "checks" }), [push]);
  const onJumpTo = useCallback<ReviewJumpTo>(
    (path, line) => {
      setFocus((current) => ({ path, line, nonce: (current?.nonce ?? 0) + 1 }));
      push({ tab: "files", path });
    },
    [push],
  );

  const queryClient = useQueryClient();
  const refresh = useCallback(() => {
    void invalidateChangeRequest(queryClient, source);
    void queryClient.invalidateQueries({ queryKey: reviewKeys.files(source) });
    void queryClient.invalidateQueries({ queryKey: ["reviewCheckDetails"] });
  }, [queryClient, source]);

  const url = timeline.overview?.url ?? seed?.url ?? null;
  const brandLabel = getForgePresentation(timeline.forge).brandLabel;

  return (
    <ReviewWriteProvider source={source} timeline={timeline}>
      <View style={styles.detail} testID="review-detail">
        <ReviewDetailBar
          source={source}
          identity={`${source.owner}/${source.name} #${source.number}`}
          navigation={navigation}
          onHome={onHome}
          url={url}
          brandLabel={brandLabel}
          onRefresh={refresh}
          refreshing={timeline.isRefreshing}
        />
        <ReviewPullRequestHeader
          tab={tab}
          onTabChange={onTabChange}
          timeline={timeline}
          seed={seed}
          trailing={headerButton}
        />
        <View style={styles.body}>
          {tab === "conversation" ? (
            <ReviewConversation
              timeline={timeline}
              onJumpTo={onJumpTo}
              onOpenChecks={onOpenChecks}
            />
          ) : null}
          {tab === "commits" ? <ReviewCommits source={source} /> : null}
          {tab === "checks" ? (
            <ReviewChecks
              source={source}
              timeline={timeline}
              selection={selection}
              onSelectionChange={setSelection}
              onJumpTo={onJumpTo}
            />
          ) : null}
          {tab === "files" ? <ReviewDesk source={source} focus={focus} /> : null}
        </View>
        {isCompact ? (
          <View style={styles.reviewBar}>
            <ReviewChangesButton onPress={openReview} />
          </View>
        ) : null}
        <ReviewChangesSheet visible={reviewOpen} onClose={closeReview} onGoTo={onJumpTo} />
        <ReviewFixSheet
          source={source}
          selection={selection}
          visible={fixOpen}
          onClose={closeFixSheet}
        />
      </View>
    </ReviewWriteProvider>
  );
}

function WorktreePage({
  source,
  navigation,
  onHome,
}: {
  source: CheckoutSource;
  navigation: ReviewNavigation;
  onHome: () => void;
}) {
  const worktree = useWorktreeHeader(source);
  const { push } = navigation;
  // Each compare is its own history entry, so back steps through them.
  const onCompareChange = useCallback(
    (mode: CheckoutSource["compare"]["mode"]) =>
      push({ source: { ...source, compare: { ...source.compare, mode } } }),
    [push, source],
  );
  const onOpenPullRequest = useCallback(
    (ref: ChangeRequestSource) => push({ source: ref, tab: "conversation", path: null }),
    [push],
  );
  const queryClient = useQueryClient();
  // The diff and status are pushed; refreshing re-reads them, and the branch's pull request.
  const { serverId, cwd } = source;
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: checkoutStatusQueryKey(serverId, cwd) });
    void queryClient.invalidateQueries({ queryKey: checkoutPrStatusQueryKey(serverId, cwd) });
    void queryClient.invalidateQueries({ queryKey: ["checkoutDiff", serverId, cwd] });
  }, [cwd, queryClient, serverId]);
  if (!worktree) return null;
  return (
    <View style={styles.detail} testID="review-detail">
      <ReviewDetailBar
        source={source}
        identity={worktree.title}
        navigation={navigation}
        onHome={onHome}
        url={null}
        brandLabel=""
        onRefresh={refresh}
        refreshing={false}
      />
      <ReviewWorktreeHeader
        source={source}
        worktree={worktree}
        onCompareChange={onCompareChange}
        onOpenPullRequest={onOpenPullRequest}
      />
      <View style={styles.body}>
        <ReviewDesk source={source} focus={null} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  detail: { flex: 1, minWidth: 0 },
  body: { flex: 1, minHeight: 0 },
  reviewBar: { padding: theme.spacing[3] },
}));
