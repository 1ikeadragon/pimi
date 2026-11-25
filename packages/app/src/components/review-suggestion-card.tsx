import { memo, useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { GitCompareArrows } from "lucide-react-native";
import type { AgentReviewSuggestionMarker } from "@pimi/protocol/agent-types";
import {
  PimiReviewSuggestionResult,
  type PimiReviewSuggestion,
  type PimiReviewSummary,
} from "@pimi/protocol/pimi-task";
import { readPimiToolOutput } from "@/components/pimi-task-proposal-card";
import { DiffStat } from "@/components/diff-stat";
import { Button } from "@/components/ui/button";
import { mapLayout } from "@/components/ui/control-sizing";
import { CONTROL_HEIGHTS } from "@/components/ui/control-geometry";
import { DensityIcon } from "@/components/ui/density-icon";
import { RAIL_NOTE_HEIGHT } from "@/components/permission-resolution-note";
import { PressHighlight } from "@/components/ui/press-highlight";
import { COMPACT_CONTENT_WIDTH, useIsCompactFormFactor } from "@/constants/layout";
import { useCheckoutStatusCacheOnly } from "@/git/use-status-query";
import { useContainerWidthBelow } from "@/hooks/use-container-width";
import { useTranslation } from "@/i18n/use-translation";
import { checkoutReviewSource, openPimiReview } from "@/navigation/pimi-review";

export function readPimiReviewSuggestion(output: unknown): PimiReviewSuggestion | null {
  return readPimiToolOutput(output, PimiReviewSuggestionResult)?.pimiReviewSuggestion ?? null;
}

interface ReviewOffer {
  serverId: string;
  /** The checkout folder Review opens. */
  path: string;
  baseRef?: string | null;
  /** The chat that made the offer; the review's notes go back to it. */
  originAgentId: string;
  branch?: string | null;
  /** The diff size when the offer was made; null when it was not known. */
  stats: PimiReviewSummary | null;
  /** What the agent said about the change, when it called the review tool itself. */
  summary?: string;
}

function useReviewOffer(offer: ReviewOffer) {
  const { serverId, path, baseRef, originAgentId } = offer;
  const openReview = useCallback(
    () =>
      openPimiReview(
        checkoutReviewSource({
          serverId,
          cwd: path,
          originAgentId,
          ...(baseRef ? { baseRef } : {}),
        }),
      ),
    [serverId, path, baseRef, originAgentId],
  );
  // Cache only: a timeline can hold many offers, and none of them is worth a status fetch.
  const status = useCheckoutStatusCacheOnly({ serverId, cwd: path }).data;
  // Known, clean, and level with its base: nothing is left to review. A missing base
  // (`aheadBehind` null) or a status never fetched stays unknown, so the offer's numbers stand.
  const nothingLeft =
    status?.isGit === true && status.isDirty === false && status.aheadBehind?.ahead === 0;
  return { openReview, nothingLeft };
}

/** The offer as one card: what changed, where it will be compared, and the button to review it. */
const ReviewSuggestionCardView = memo(function ReviewSuggestionCardView({
  offer,
}: {
  offer: ReviewOffer;
}) {
  const { t } = useTranslation();
  const isCompactFormFactor = useIsCompactFormFactor();
  const { onLayout, isBelow: isCompactLayout } = useContainerWidthBelow(COMPACT_CONTENT_WIDTH, {
    initialIsBelow: isCompactFormFactor,
  });
  const { openReview, nothingLeft } = useReviewOffer(offer);
  const { stats, summary, branch, baseRef } = offer;

  let detail = summary ?? null;
  if (!detail && branch) detail = baseRef ? `${branch} → ${baseRef}` : branch;

  let headline: string;
  if (nothingLeft) headline = t("agentStream.reviewSuggestion.stale");
  else if (stats)
    headline = t("agentStream.reviewSuggestion.filesChanged", { count: stats.filesChanged });
  else headline = t("agentStream.reviewSuggestion.ready");

  const title = (
    <View style={styles.titleGroup}>
      <DensityIcon icon={GitCompareArrows} size="sm" color="foregroundMuted" />
      <Text
        accessibilityRole="header"
        numberOfLines={1}
        style={nothingLeft ? styles.headlineMuted : styles.headline}
      >
        {headline}
      </Text>
      {stats && !nothingLeft ? (
        <DiffStat
          additions={stats.additions}
          deletions={stats.deletions}
          additionsIncomplete={stats.incomplete}
        />
      ) : null}
    </View>
  );
  const detailText = detail ? (
    <Text numberOfLines={1} style={styles.detail}>
      {detail}
    </Text>
  ) : (
    <View style={styles.detailSpacer} />
  );
  const action = (
    <Button variant="secondary" size="sm" onPress={openReview}>
      {t("agentStream.reviewSuggestion.open")}
    </Button>
  );

  if (isCompactLayout) {
    return (
      <View style={styles.card} onLayout={onLayout} testID="pimi-review-suggestion">
        <View style={styles.compactRow}>{title}</View>
        <View style={styles.compactRow}>
          {detailText}
          {action}
        </View>
      </View>
    );
  }
  return (
    <View
      style={[styles.card, styles.cardWide]}
      onLayout={onLayout}
      testID="pimi-review-suggestion"
    >
      {title}
      {detailText}
      {action}
    </View>
  );
});

/** An earlier offer in the same timeline: one muted line on the activity rail that still opens Review. */
const ReviewSuggestionNote = memo(function ReviewSuggestionNote({ offer }: { offer: ReviewOffer }) {
  const { t } = useTranslation();
  const { openReview } = useReviewOffer(offer);
  const [isHovered, setIsHovered] = useState(false);
  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);
  const textStyle = useMemo(
    () => [styles.noteText, isHovered && styles.noteTextHovered],
    [isHovered],
  );
  const label = offer.stats
    ? t("agentStream.reviewSuggestion.earlier", {
        files: t("agentStream.reviewSuggestion.filesChanged", { count: offer.stats.filesChanged }),
      })
    : t("agentStream.reviewSuggestion.earlierNoStats");
  return (
    <PressHighlight
      style={[styles.note, isHovered && styles.noteHovered]}
      highlightStyle={styles.notePressed}
      onPress={openReview}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      accessibilityRole="link"
      testID="pimi-review-suggestion-note"
    >
      <View style={styles.noteIcon}>
        <DensityIcon icon={GitCompareArrows} size="sm" color="foregroundMuted" />
      </View>
      <Text style={textStyle} numberOfLines={1}>
        {label}
      </Text>
    </PressHighlight>
  );
});

/** The card for a review the agent offered by calling the tool: its summary, no diff size. */
export function PimiReviewSuggestionCard({ suggestion }: { suggestion: PimiReviewSuggestion }) {
  const offer = useMemo<ReviewOffer>(
    () => ({
      serverId: suggestion.source.serverId,
      path: suggestion.path,
      originAgentId: suggestion.source.agentId,
      stats: null,
      summary: suggestion.summary,
    }),
    [suggestion],
  );
  return <ReviewSuggestionCardView offer={offer} />;
}

/**
 * The daemon's end-of-turn offer, which names the checkout and its diff size. Only the newest
 * offer in a timeline is a card; the rest are `superseded` and shrink to a note, because a
 * second card for the same checkout reads as a second thing to do.
 */
export function PimiReviewSuggestionNotificationCard({
  marker,
  serverId,
  superseded,
}: {
  marker: AgentReviewSuggestionMarker;
  serverId: string;
  superseded: boolean;
}) {
  const offer = useMemo<ReviewOffer>(
    () => ({
      serverId,
      path: marker.path,
      originAgentId: marker.origin.agentId,
      baseRef: marker.baseRef,
      branch: marker.branch,
      stats: marker.stats,
    }),
    [serverId, marker.path, marker.origin.agentId, marker.baseRef, marker.branch, marker.stats],
  );
  return superseded ? (
    <ReviewSuggestionNote offer={offer} />
  ) : (
    <ReviewSuggestionCardView offer={offer} />
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    marginVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderWidth: theme.borderWidth[1],
    borderRadius: theme.borderRadius.lg,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    gap: theme.spacing[2],
  },
  // One control-height row plus the vertical padding, so the card does not move when a count resolves.
  cardWide: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: mapLayout(CONTROL_HEIGHTS.sm, (height) => height + theme.spacing[2] * 2),
  },
  compactRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: CONTROL_HEIGHTS.sm,
  },
  titleGroup: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 0,
    gap: theme.spacing[2],
  },
  headline: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
  },
  headlineMuted: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  detail: {
    flex: 1,
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  // Keeps the button on the trailing rail when there is nothing to say between.
  detailSpacer: { flex: 1 },
  // Sits on the activity rows' rail, as `PermissionResolutionNote` does.
  note: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    maxWidth: "100%",
    marginLeft: -theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    height: RAIL_NOTE_HEIGHT,
    borderRadius: theme.borderRadius.lg,
  },
  noteHovered: { backgroundColor: theme.colors.interactionHighlight },
  notePressed: { backgroundColor: theme.colors.interactionHighlight },
  noteIcon: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    alignItems: "center",
    justifyContent: "center",
    marginRight: theme.spacing[3],
  },
  noteText: {
    flexShrink: 1,
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  noteTextHovered: { color: theme.colors.foreground },
}));
