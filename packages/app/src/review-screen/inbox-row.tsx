// Pimi. PolyForm-Noncommercial-1.0.0.
// One row of the Review home. A grid with fixed tracks (state 20 | title | checks 96 | decision
// 132 | age 44) so nothing shifts when a value arrives; an empty value keeps its track. Compact
// screens stack the same facts on three lines. Pressing a row prefetches the whole page; on web a
// hover prefetches the REST reads.
import { memo, useCallback, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { GitPullRequestDraft } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useIsCompactFormFactor } from "@/constants/layout";
import { PullRequestStateIcon } from "@/git/pull-request-state-icon";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { DecisionChip, InboxChecks } from "./chips";
import { prefetchChangeRequest, prefetchOnHover } from "./queries";
import type { ChangeRequestSource } from "./types";
import type { InboxItem } from "./use-inbox";

export const INBOX_ROW_HEIGHT = 56;
export const INBOX_ROW_HEIGHT_COMPACT = 72;
const STATE_TRACK = 20;
const CHECKS_TRACK = 96;
const DECISION_TRACK = 132;
const AGE_TRACK = 44;

const ThemedDraftIcon = withUnistyles(GitPullRequestDraft);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** "2h", "5d": the row's age track is 44 wide. Empty when the forge sent no timestamp. */
export function formatInboxAge(updatedAt: string | null, now = Date.now()): string {
  if (!updatedAt) return "";
  const then = Date.parse(updatedAt);
  if (!Number.isFinite(then)) return "";
  const minutes = Math.max(0, Math.floor((now - then) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 60) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 30)}mo`;
}

function StateGlyph({ item }: { item: InboxItem }) {
  if (item.state === "open" && item.isDraft)
    return <ThemedDraftIcon size={16} uniProps={mutedMapping} />;
  return <PullRequestStateIcon state={item.state} size={16} />;
}

/** Press-in prefetches the whole page (it buys the tap duration); hover prefetches REST reads. */
function useRowPrefetch(ref: ChangeRequestSource) {
  const queryClient = useQueryClient();
  const cancelHover = useRef<(() => void) | null>(null);
  const onPressIn = useCallback(() => {
    prefetchChangeRequest(queryClient, getHostRuntimeStore().getClient(ref.serverId), ref);
  }, [queryClient, ref]);
  const onHoverIn = useCallback(() => {
    cancelHover.current?.();
    cancelHover.current = prefetchOnHover(queryClient, ref);
  }, [queryClient, ref]);
  const onHoverOut = useCallback(() => {
    cancelHover.current?.();
    cancelHover.current = null;
  }, []);
  return { onPressIn, onHoverIn, onHoverOut };
}

function rowStyle({ hovered }: { hovered?: boolean }) {
  return [styles.row, Boolean(hovered) && styles.rowHovered];
}
function rowStyleCompact({ hovered }: { hovered?: boolean }) {
  return [styles.rowCompact, Boolean(hovered) && styles.rowHovered];
}

export const InboxRow = memo(function InboxRow({
  item,
  serverId,
  onOpen,
}: {
  item: InboxItem;
  serverId: string;
  onOpen: (source: ChangeRequestSource) => void;
}) {
  const isCompact = useIsCompactFormFactor();
  const ref = useMemo<ChangeRequestSource>(
    () => ({
      kind: "change_request",
      serverId,
      forgeHost: item.forgeHost,
      owner: item.owner,
      name: item.name,
      number: item.number,
    }),
    [serverId, item.forgeHost, item.owner, item.name, item.number],
  );
  const handlePress = useCallback(() => onOpen(ref), [onOpen, ref]);
  const { onPressIn, onHoverIn, onHoverOut } = useRowPrefetch(ref);
  const age = formatInboxAge(item.updatedAt);
  const meta = [
    `${item.owner}/${item.name} #${item.number}`,
    item.author,
    item.headRefName && item.baseRefName ? `${item.headRefName} → ${item.baseRefName}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <PressHighlight
      onPress={handlePress}
      onPressIn={onPressIn}
      onHoverIn={onHoverIn}
      onHoverOut={onHoverOut}
      accessibilityRole="button"
      style={isCompact ? rowStyleCompact : rowStyle}
      testID={`review-inbox-row-${item.owner}-${item.name}-${item.number}`}
    >
      <View style={styles.state}>
        <StateGlyph item={item} />
      </View>
      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={isCompact ? 2 : 1}>
          {item.title}
        </Text>
        <Text style={styles.meta} numberOfLines={1} ellipsizeMode="middle">
          {meta}
        </Text>
        {isCompact ? (
          <View style={styles.compactFacts}>
            <InboxChecks status={item.checksStatus} />
            <DecisionChip decision={item.reviewDecision} size="xs" />
            <Text style={styles.age}>{age}</Text>
          </View>
        ) : null}
      </View>
      {isCompact ? null : (
        <>
          <View style={styles.checksTrack}>
            <InboxChecks status={item.checksStatus} />
          </View>
          <View style={styles.decisionTrack}>
            <DecisionChip decision={item.reviewDecision} size="xs" />
          </View>
          <Text style={styles.ageTrack}>{age}</Text>
        </>
      )}
    </PressHighlight>
  );
});

const styles = StyleSheet.create((theme) => ({
  row: {
    height: INBOX_ROW_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
  },
  rowCompact: {
    minHeight: INBOX_ROW_HEIGHT_COMPACT,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
  },
  rowHovered: { backgroundColor: theme.colors.surfaceSidebarHover },
  state: { width: STATE_TRACK, alignItems: "center" },
  text: { flex: 1, minWidth: 0, gap: 2 },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  meta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  compactFacts: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
  checksTrack: { width: CHECKS_TRACK },
  decisionTrack: { width: DECISION_TRACK, alignItems: "flex-start" },
  ageTrack: {
    width: AGE_TRACK,
    textAlign: "right",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  age: {
    marginLeft: "auto",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
}));
