import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ActionItem, ActionItemsEdit } from "@pimi/protocol/action-items/types";
import { Enter } from "@/action-items/enter";
import { useActionItems } from "@/action-items/use-action-items";
import { TaskStatusMark } from "@/components/tasks/task-status-mark";
import { Button } from "@/components/ui/button";
import {
  ComposerTrackPill,
  ComposerTrackRow,
  type ComposerTrackPillSegment,
} from "@/composer/tracks";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useTranslation } from "@/i18n/use-translation";

interface ReviewGroups {
  looksDone: ActionItem[];
  closedThisRun: ActionItem[];
  open: ActionItem[];
}

function groupItems(items: readonly ActionItem[], lastRunAt: string | undefined): ReviewGroups {
  const groups: ReviewGroups = { looksDone: [], closedThisRun: [], open: [] };
  for (const item of items) {
    if (!item.done) {
      (item.suggestion ? groups.looksDone : groups.open).push(item);
    } else if (
      item.doneSetBy === "model" &&
      lastRunAt !== undefined &&
      item.completedAt === lastRunAt
    ) {
      groups.closedThisRun.push(item);
    }
  }
  return groups;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Plain objects: the entering node carries no Unistyles style.
const enterStyle = { flexShrink: 0, transformOrigin: "left center" } as const;

/**
 * The composer's review pill for action items. The daemon closes items it has proof for and only
 * suggests the rest; this is where a person reviews both without opening the list. It shows only
 * when there is something to review: items the model thinks are done, or that its latest run
 * closed. Both go away on their own: a suggestion is answered, and the next run that closes
 * nothing moves `lastRunAt` past the closed ones.
 *
 * The note over the transcript and this pill subscribe to the same chat independently. The
 * subscriptions are separate owners on the daemon (`session.events.set_subscription.request`),
 * and both write the same pushed state to one query key, so the second is redundant, not
 * conflicting.
 */
export const ActionItemsReviewTrack = memo(function ActionItemsReviewTrack({
  serverId,
  agentId,
}: {
  serverId: string;
  agentId: string;
}): ReactElement | null {
  const { config } = useDaemonConfig(serverId);
  const featureOff = config?.metadataGeneration.actionItems === false;
  const model = useActionItems({ serverId, agentId, active: !featureOff });
  const state = model.state?.agentId === agentId ? model.state : null;
  const groups = useMemo(
    () => groupItems(state?.items ?? [], state?.lastRunAt),
    [state?.items, state?.lastRunAt],
  );
  const shows = !featureOff && (groups.looksDone.length > 0 || groups.closedThisRun.length > 0);

  // A pill over a chat that already has something to review appears in place. One that appears
  // while the chat is on screen enters. A count that changes while the pill is up does not
  // replay it: remounting would close the panel someone is working in.
  const sawHidden = useRef(false);
  if (state && !shows) sawHidden.current = true;
  useEffect(() => {
    if (shows) sawHidden.current = false;
  }, [shows]);

  if (!state || !shows) return null;
  return (
    <Enter kind="card" animate={sawHidden.current} style={enterStyle}>
      <ReviewPill groups={groups} edit={model.edit} />
    </Enter>
  );
});

const ReviewPill = memo(function ReviewPill({
  groups,
  edit,
}: {
  groups: ReviewGroups;
  edit: (edit: ActionItemsEdit) => Promise<void>;
}): ReactElement {
  const { t } = useTranslation();
  const [failure, setFailure] = useState<string | null>(null);
  const send = useCallback(
    (change: ActionItemsEdit) => {
      edit(change)
        .then(() => setFailure(null))
        .catch((error: unknown) => setFailure(errorText(error)));
    },
    [edit],
  );
  const handleMarkDone = useCallback(
    (item: ActionItem) => send({ kind: "set_done", itemId: item.id, done: true }),
    [send],
  );
  const handleReopen = useCallback(
    (item: ActionItem) => send({ kind: "set_done", itemId: item.id, done: false }),
    [send],
  );
  const handleKeepOpen = useCallback(
    (item: ActionItem) => send({ kind: "dismiss_suggestion", itemId: item.id }),
    [send],
  );

  const segments = useMemo((): ComposerTrackPillSegment[] => {
    const result: ComposerTrackPillSegment[] = [];
    if (groups.looksDone.length > 0) {
      result.push({
        bucket: "attention",
        text: t("actionItems.reviewLooksDone", { count: groups.looksDone.length }),
      });
    }
    if (groups.closedThisRun.length > 0) {
      result.push({
        bucket: "done",
        text: t("actionItems.reviewClosed", { count: groups.closedThisRun.length }),
      });
    }
    return result;
  }, [groups.looksDone.length, groups.closedThisRun.length, t]);

  return (
    <ComposerTrackPill
      testID="action-items-review"
      segments={segments}
      panelTitle={t("actionItems.label")}
    >
      <ReviewSection
        title={t("actionItems.reviewLooksDoneHeading")}
        count={groups.looksDone.length}
      >
        {groups.looksDone.map((item) => (
          <LooksDoneRow
            key={item.id}
            item={item}
            onKeepOpen={handleKeepOpen}
            onMarkDone={handleMarkDone}
          />
        ))}
      </ReviewSection>
      <ReviewSection
        title={t("actionItems.reviewClosedHeading")}
        count={groups.closedThisRun.length}
      >
        {groups.closedThisRun.map((item) => (
          <ClosedRow key={item.id} item={item} onUndo={handleReopen} />
        ))}
      </ReviewSection>
      <ReviewSection title={t("actionItems.reviewOpenHeading")} count={groups.open.length}>
        {groups.open.map((item) => (
          <OpenRow key={item.id} item={item} onMarkDone={handleMarkDone} />
        ))}
      </ReviewSection>
      {failure ? (
        <Text style={styles.error} numberOfLines={3} testID="action-items-review-error">
          {failure}
        </Text>
      ) : null}
    </ComposerTrackPill>
  );
});

function ReviewSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}): ReactElement | null {
  if (count === 0) return null;
  return (
    <View>
      <Text style={styles.heading}>{title}</Text>
      {children}
    </View>
  );
}

function LooksDoneRow({
  item,
  onKeepOpen,
  onMarkDone,
}: {
  item: ActionItem;
  onKeepOpen: (item: ActionItem) => void;
  onMarkDone: (item: ActionItem) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleKeepOpen = useCallback(() => onKeepOpen(item), [item, onKeepOpen]);
  const handleMarkDone = useCallback(() => onMarkDone(item), [item, onMarkDone]);
  return (
    <ComposerTrackRow testID={`action-items-review-row-${item.id}`}>
      <ReviewText item={item} evidence={item.suggestion?.evidence} />
      <Button
        variant="ghost"
        size="sm"
        onPress={handleKeepOpen}
        testID={`action-items-review-keep-open-${item.id}`}
      >
        {t("actionItems.keepOpen")}
      </Button>
      <Button
        size="sm"
        onPress={handleMarkDone}
        testID={`action-items-review-mark-done-${item.id}`}
      >
        {t("actionItems.markDoneAction")}
      </Button>
    </ComposerTrackRow>
  );
}

function ClosedRow({
  item,
  onUndo,
}: {
  item: ActionItem;
  onUndo: (item: ActionItem) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleUndo = useCallback(() => onUndo(item), [item, onUndo]);
  return (
    <ComposerTrackRow testID={`action-items-review-row-${item.id}`}>
      <ReviewText item={item} evidence={item.doneEvidence} />
      <Button
        variant="ghost"
        size="sm"
        onPress={handleUndo}
        testID={`action-items-review-undo-${item.id}`}
      >
        {t("actionItems.undo")}
      </Button>
    </ComposerTrackRow>
  );
}

function OpenRow({
  item,
  onMarkDone,
}: {
  item: ActionItem;
  onMarkDone: (item: ActionItem) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleMarkDone = useCallback(() => onMarkDone(item), [item, onMarkDone]);
  return (
    <ComposerTrackRow testID={`action-items-review-row-${item.id}`}>
      <TaskStatusMark
        status="todo"
        label={t("actionItems.markDone", { text: item.text })}
        onToggle={handleMarkDone}
        testID={`action-items-review-open-mark-${item.id}`}
      />
      <ReviewText item={item} evidence={undefined} />
    </ComposerTrackRow>
  );
}

// The item and, under it, what the model said, as plain text: the evidence quotes command output,
// so it is never markdown.
function ReviewText({
  item,
  evidence,
}: {
  item: ActionItem;
  evidence: string | undefined;
}): ReactElement {
  return (
    <View style={styles.text}>
      <Text style={styles.itemText} numberOfLines={2}>
        {item.text}
      </Text>
      {evidence ? (
        <Text style={styles.evidence} numberOfLines={3}>
          {evidence}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  heading: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
  },
  // Basis stays `auto` so the text's width reaches the panel's measurement, as in task-list.
  text: { flexGrow: 1, flexShrink: 1, flexBasis: "auto", minWidth: 0 },
  itemText: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  evidence: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
}));
