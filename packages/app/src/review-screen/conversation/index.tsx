// Pimi. PolyForm-Noncommercial-1.0.0.
// The Conversation tab: the description, then every comment and review in order, review threads
// nested under the review that opened them. The comment box ends the list; thread actions write through `write/`. A 260 aside carries review state, checks and labels when the body is wide.
import { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "@/i18n/use-translation";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { SkeletonPulse, useSkeletonPulse } from "@/components/ui/skeleton";
import { getForgePresentation } from "@/git/forge";
import { ActivityAvatar, ActivityHeader } from "@/git/pull-request-panel/activity-kit";
import { deriveAvatarColor, formatAge } from "@/git/pull-request-panel/data";
import type { PrPaneActivity } from "@/git/pull-request-panel/data";
import type { PrReviewEntry, PrTimelineEntry } from "@/git/pull-request-panel/timeline";
import { openExternalUrl } from "@/utils/open-external-url";
import { Notice } from "../notice";
import type { ReviewJumpTo } from "../types";
import type { ReviewTimeline } from "../use-review-timeline";
import { ConversationAside, ConversationSummary } from "./aside";
import { ThreadCard } from "./thread-card";
import { ReviewComposer } from "../write/composer";
import { useReviewWriteContext } from "../write/use-review-writes";

/** The body is wide enough for the 260 aside beside a 860 column. */
const ASIDE_MIN_BODY_WIDTH = 1160;

function onLinkPress(url: string): boolean {
  void openExternalUrl(url);
  return false;
}

export function ReviewConversation({
  timeline,
  onJumpTo,
  onOpenChecks,
}: {
  timeline: ReviewTimeline;
  onJumpTo: ReviewJumpTo;
  onOpenChecks: () => void;
}) {
  const { t } = useTranslation();
  const [width, setWidth] = useState(0);
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width),
    [],
  );
  const { overview } = timeline;
  if (timeline.error && !overview) {
    return <Notice text={timeline.error.message} onRetry={timeline.refresh} />;
  }
  const wide = width >= ASIDE_MIN_BODY_WIDTH;
  const brandLabel = getForgePresentation(timeline.forge).brandLabel;
  return (
    <View style={styles.root} onLayout={onLayout} testID="review-conversation">
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.row}>
          <View style={styles.main}>
            {wide ? null : <ConversationSummary timeline={timeline} />}
            {overview ? <DescriptionEntry overview={overview} /> : <DescriptionSkeleton />}
            {timeline.entries.map((entry) => (
              <TimelineEntry
                key={entry.id}
                entry={entry}
                brandLabel={brandLabel}
                onJumpTo={onJumpTo}
              />
            ))}
            <CommentBox />
            {timeline.threadsError ? (
              <Text style={styles.error}>{timeline.threadsError.message}</Text>
            ) : null}
            {timeline.threadsTruncated ? (
              <Text style={styles.muted}>{t("reviewScreen.conversation.truncated")}</Text>
            ) : null}
            {!timeline.threadsLoading && !timeline.threadsError && timeline.entries.length === 0 ? (
              <Text style={styles.muted}>{t("reviewScreen.conversation.noActivity")}</Text>
            ) : null}
          </View>
          {wide ? <ConversationAside timeline={timeline} onOpenChecks={onOpenChecks} /> : null}
        </View>
      </ScrollView>
    </View>
  );
}

/** The comment box at the end of the list. Hidden when the forge has no PR comments. */
function CommentBox() {
  const { t } = useTranslation();
  const write = useReviewWriteContext();
  const createComment = write?.writes.createComment;
  const onSubmit = useCallback(
    (body: string, mutationId: string) => {
      if (!createComment) throw new Error("no write context");
      return createComment({ body, mutationId });
    },
    [createComment],
  );
  if (!write || !write.actions?.comment) return null;
  return (
    <ReviewComposer
      placeholder={t("reviewScreen.write.commentPlaceholder")}
      submitLabel={t("reviewScreen.write.comment")}
      disabled={!write.connected}
      onSubmit={onSubmit}
      testID="review-comment-box"
    />
  );
}

function DescriptionEntry({ overview }: { overview: NonNullable<ReviewTimeline["overview"]> }) {
  const { t } = useTranslation();
  const author = overview.author ?? t("reviewScreen.conversation.unknownAuthor");
  const created = overview.createdAt ? Date.parse(overview.createdAt) : Number.NaN;
  const activity = useMemo<PrPaneActivity>(
    () => ({
      provider: "github",
      id: "description",
      kind: "comment",
      author,
      avatarColor: deriveAvatarColor(author),
      body: overview.body,
      age: Number.isFinite(created) ? formatAge(created) : "",
      url: overview.url,
    }),
    [author, created, overview.body, overview.url],
  );
  return (
    <View style={styles.block} testID="review-conversation-description">
      <View style={styles.blockHead}>
        <ActivityAvatar activity={activity} size={20} />
        <Text style={styles.author} numberOfLines={1}>
          {author}
        </Text>
        <Text style={styles.muted}>{t("reviewScreen.conversation.opened")}</Text>
        <Text style={[styles.muted, styles.age]}>{activity.age}</Text>
      </View>
      <View style={styles.blockBody}>
        {overview.body.trim() ? (
          <MarkdownRenderer text={overview.body} onLinkPress={onLinkPress} />
        ) : (
          <Text style={styles.muted}>{t("reviewScreen.conversation.noDescription")}</Text>
        )}
      </View>
    </View>
  );
}

function DescriptionSkeleton() {
  const pulse = useSkeletonPulse();
  return (
    <View style={styles.block} testID="review-conversation-skeleton">
      <View style={styles.blockHead}>
        <SkeletonPulse pulse={pulse} style={styles.skeletonAvatar} />
        <SkeletonPulse pulse={pulse} style={styles.skeletonName} />
      </View>
      <View style={styles.blockBody}>
        <SkeletonPulse pulse={pulse} style={styles.skeletonLine} />
        <SkeletonPulse pulse={pulse} style={styles.skeletonLineShort} />
      </View>
    </View>
  );
}

function TimelineEntry({
  entry,
  brandLabel,
  onJumpTo,
}: {
  entry: PrTimelineEntry;
  brandLabel: string;
  onJumpTo: ReviewJumpTo;
}) {
  if (entry.kind === "thread") {
    return <ThreadCard entry={entry} nested={false} brandLabel={brandLabel} onJumpTo={onJumpTo} />;
  }
  if (entry.kind === "review") {
    return <ReviewBlock entry={entry} brandLabel={brandLabel} onJumpTo={onJumpTo} />;
  }
  return <ActivityBlock activity={entry.activity} />;
}

function ActivityBlock({ activity }: { activity: PrPaneActivity }) {
  return (
    <View style={styles.block} testID={`review-entry-${activity.id}`}>
      <View style={styles.blockHead}>
        <ActivityHeader activity={activity} avatarSize={20} />
      </View>
      {activity.body.trim() ? (
        <View style={styles.blockBody}>
          <MarkdownRenderer text={activity.body} onLinkPress={onLinkPress} />
        </View>
      ) : null}
    </View>
  );
}

function ReviewBlock({
  entry,
  brandLabel,
  onJumpTo,
}: {
  entry: PrReviewEntry;
  brandLabel: string;
  onJumpTo: ReviewJumpTo;
}) {
  return (
    <View style={styles.block} testID={`review-entry-${entry.review.id}`}>
      <View style={styles.blockHead}>
        <ActivityHeader activity={entry.review} avatarSize={20} />
      </View>
      {entry.review.body.trim() ? (
        <View style={styles.blockBody}>
          <MarkdownRenderer text={entry.review.body} onLinkPress={onLinkPress} />
        </View>
      ) : null}
      {entry.threads.map((thread) => (
        <ThreadCard
          key={thread.id}
          entry={thread}
          nested
          brandLabel={brandLabel}
          onJumpTo={onJumpTo}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, minWidth: 0, minHeight: 0 },
  scroll: { padding: theme.spacing[6] },
  row: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "flex-start",
    gap: theme.spacing[6],
  },
  main: { flex: 1, minWidth: 0, maxWidth: 860, gap: theme.spacing[3] },
  block: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
  },
  blockHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
  },
  blockBody: { padding: theme.spacing[3], gap: theme.spacing[2] },
  author: { flexShrink: 1, color: theme.colors.foreground, fontSize: theme.fontSize.base },
  age: { marginLeft: "auto" },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
  skeletonAvatar: {
    width: 20,
    height: 20,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
  },
  skeletonName: {
    width: 120,
    height: 12,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface3,
  },
  skeletonLine: {
    width: "80%",
    height: 12,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface3,
  },
  skeletonLineShort: {
    width: "50%",
    height: 12,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface3,
  },
}));
