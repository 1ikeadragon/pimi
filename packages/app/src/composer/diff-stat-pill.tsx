import { memo, useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text } from "react-native";
import { useTranslation } from "react-i18next";
import { DiffStat } from "@/components/diff-stat";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { composerPillStyles } from "@/composer/pill-styles";
import { useVisibleWorkspaceDiffStat } from "@/composer/workspace-diff-stat";
import { useFetchQuery } from "@/data/query";
import { getDesktopHost, type DesktopHostBridge } from "@/desktop/host";
import { usePimiWorkspaceSection } from "@/desktop/pimi-console-content";
import type { PimiWorkspaceReview } from "@/desktop/use-pimi-workspace-review";

interface ComposerDiffStatPillProps {
  additions: number;
  deletions: number;
  filesChanged?: number;
  additionsIncomplete?: boolean;
  opensReview?: boolean;
  onPress: () => void;
}

export function ComposerDiffStatPill({
  additions,
  deletions,
  filesChanged,
  additionsIncomplete,
  opensReview,
  onPress,
}: ComposerDiffStatPillProps) {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);
  const bodyStyle = useMemo(
    () => [composerPillStyles.body, isHovered && composerPillStyles.bodyActive],
    [isHovered],
  );
  const fileCount =
    filesChanged === undefined
      ? null
      : `${filesChanged} ${filesChanged === 1 ? "file" : "files"} changed`;
  const accessibilityLabel = opensReview
    ? [
        "Review changes",
        fileCount,
        additionsIncomplete ? `at least ${additions} added lines` : `+${additions}`,
        `-${deletions}`,
      ]
        .filter(Boolean)
        .join(", ")
    : t("workspace.git.diff.openChangesTab");

  return (
    <Pressable
      testID="composer-diff-stat-pill"
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      style={bodyStyle}
    >
      {fileCount ? <Text style={composerPillStyles.label}>{fileCount}</Text> : null}
      <DiffStat
        additions={additions}
        deletions={deletions}
        additionsIncomplete={additionsIncomplete}
      />
    </Pressable>
  );
}

export const WorkspaceDiffStatPill = memo(function WorkspaceDiffStatPill({
  serverId,
  workspaceId,
  onPress,
  pimiReview,
  isWorkspaceFocused,
}: {
  serverId: string;
  workspaceId: string;
  onPress: () => void;
  pimiReview: PimiWorkspaceReview | null;
  isWorkspaceFocused: boolean;
}): ReactElement | null {
  const getSummary = getDesktopHost()?.getPimiReviewSummary;
  if (pimiReview && getSummary) {
    return (
      <PimiDiffStatPill
        review={pimiReview}
        isWorkspaceFocused={isWorkspaceFocused}
        getSummary={getSummary}
      />
    );
  }
  return (
    <ChangesDiffStatPill
      serverId={serverId}
      workspaceId={workspaceId}
      onPress={pimiReview?.open ?? onPress}
      opensReview={Boolean(pimiReview)}
    />
  );
});

function ChangesDiffStatPill({
  serverId,
  workspaceId,
  onPress,
  opensReview,
}: {
  serverId: string;
  workspaceId: string;
  onPress: () => void;
  opensReview: boolean;
}) {
  const diffStat = useVisibleWorkspaceDiffStat(serverId, workspaceId);
  if (!diffStat) return null;
  return (
    <ComposerDiffStatPill
      additions={diffStat.additions}
      deletions={diffStat.deletions}
      opensReview={opensReview}
      onPress={onPress}
    />
  );
}

const REVIEW_SUMMARY_INTERVAL_MS = 2_500;

function PimiDiffStatPill({
  review,
  isWorkspaceFocused,
  getSummary,
}: {
  review: PimiWorkspaceReview;
  isWorkspaceFocused: boolean;
  getSummary: NonNullable<DesktopHostBridge["getPimiReviewSummary"]>;
}) {
  const isVisible = useRetainedPanelActive();
  const section = usePimiWorkspaceSection();
  const enabled = isWorkspaceFocused && isVisible && section === null;
  const { data: summary } = useFetchQuery({
    queryKey: ["pimi", "review-summary", review.checkout],
    queryFn: () => getSummary(review.checkout),
    dataShape: "value",
    staleTimeMs: REVIEW_SUMMARY_INTERVAL_MS,
    enabled,
    refetchInterval: enabled ? REVIEW_SUMMARY_INTERVAL_MS : false,
    retry: false,
  });
  if (!summary || summary.filesChanged === 0) return null;
  return (
    <ComposerDiffStatPill
      filesChanged={summary.filesChanged}
      additions={summary.additions}
      deletions={summary.deletions}
      additionsIncomplete={summary.incomplete}
      opensReview
      onPress={review.open}
    />
  );
}
