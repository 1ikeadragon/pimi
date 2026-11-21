// Pimi. PolyForm-Noncommercial-1.0.0.
// A pull request or worktree page: bar, header with tabs, and the tab body at full width. It owns
// the one read of the pull request (`useReviewTimeline`), the Fix-selected checks, the focus
// request a thread or check sends to the Files tab, and the Fix sheet.
import { useCallback, useState } from "react";
import { View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { StyleSheet } from "react-native-unistyles";
import { getForgePresentation } from "@/git/forge";
import { ReviewFixSheet } from "./agent-actions/fix-sheet";
import { ReviewChecks } from "./checks";
import { ReviewCommits } from "./commits";
import { ReviewConversation } from "./conversation";
import { ReviewDesk } from "./desk";
import { ReviewDetailBar, ReviewDetailHeader } from "./header";
import { invalidateChangeRequest, reviewKeys } from "./queries";
import {
  EMPTY_REVIEW_SELECTION,
  type ReviewDetailTab,
  type ReviewJumpTo,
  type ReviewNavigation,
  type ReviewSelection,
  type ReviewSource,
} from "./types";
import { useInboxSeed } from "./use-inbox";
import { useReviewTimeline } from "./use-review-timeline";

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
  const changeRequest = source.kind === "change_request" ? source : null;
  const timeline = useReviewTimeline(source);
  const seed = useInboxSeed(changeRequest);
  const [selection, setSelection] = useState<ReviewSelection>(EMPTY_REVIEW_SELECTION);
  const [focus, setFocus] = useState<{ path: string; line: number | null; nonce: number } | null>(
    null,
  );
  const [fixOpen, setFixOpen] = useState(false);
  const closeFixSheet = useCallback(() => setFixOpen(false), []);
  const { push } = navigation;
  // A worktree page has one tab; a stale tab from the pull request it replaced would show nothing.
  const activeTab: ReviewDetailTab = source.kind === "checkout" ? "files" : tab;

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
  const ref = timeline.ref;
  const refresh = useCallback(() => {
    if (!ref) return;
    void invalidateChangeRequest(queryClient, ref);
    void queryClient.invalidateQueries({ queryKey: reviewKeys.files(ref) });
    void queryClient.invalidateQueries({ queryKey: ["reviewCheckDetails"] });
  }, [queryClient, ref]);

  const url = timeline.overview?.url ?? seed?.url ?? null;
  const brandLabel = getForgePresentation(timeline.forge).brandLabel;

  return (
    <View style={styles.detail} testID="review-detail">
      <ReviewDetailBar
        source={source}
        navigation={navigation}
        onHome={onHome}
        url={url}
        brandLabel={brandLabel}
        onRefresh={refresh}
        refreshing={timeline.isRefreshing}
      />
      <ReviewDetailHeader
        source={source}
        tab={activeTab}
        onTabChange={onTabChange}
        timeline={timeline}
        seed={seed}
      />
      <View style={styles.body}>
        {activeTab === "conversation" ? (
          <ReviewConversation timeline={timeline} onJumpTo={onJumpTo} onOpenChecks={onOpenChecks} />
        ) : null}
        {activeTab === "commits" && changeRequest ? <ReviewCommits source={changeRequest} /> : null}
        {activeTab === "checks" ? (
          <ReviewChecks
            source={source}
            timeline={timeline}
            selection={selection}
            onSelectionChange={setSelection}
            onJumpTo={onJumpTo}
          />
        ) : null}
        {activeTab === "files" ? <ReviewDesk source={source} focus={focus} /> : null}
      </View>
      <ReviewFixSheet
        source={source}
        selection={selection}
        visible={fixOpen}
        onClose={closeFixSheet}
      />
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  detail: { flex: 1, minWidth: 0 },
  body: { flex: 1, minHeight: 0 },
}));
