// Pimi. PolyForm-Noncommercial-1.0.0.
// Stream S4 owns this file: the Overview tab. Stacked cards built with SettingsSection, after the
// website's Review mockup: Description, a separate Checks card (failed first, passed and skipped
// collapsed, shards folded), Threads, Commits. The same rows feed the Changes tab's inspector.
import type { TFunction } from "i18next";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "@/i18n/use-translation";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { openExternalUrl } from "@/utils/open-external-url";
import { CheckSections } from "./inspector/checks";
import { ChecksBadges } from "./inspector/checks-badges";
import { FixSelectedBar } from "./inspector/fix-selected-bar";
import { ThreadRows, filterThreads, type ThreadFilter } from "./inspector/threads";
import type { ReviewOverviewProps } from "./types";
import { useReviewTimeline, type ReviewTimeline } from "./use-review-timeline";

type Overview = NonNullable<ReviewTimeline["overview"]>;
type CardProps = Pick<
  ReviewOverviewProps,
  "source" | "onJumpTo" | "selection" | "onSelectionChange"
>;

export function ReviewOverview(props: ReviewOverviewProps) {
  const { t } = useTranslation();
  const timeline = useReviewTimeline(props.source);
  const { overview } = timeline;

  if (timeline.noChangeRequest) {
    return <Notice text={t("reviewScreen.overview.noPullRequest")} />;
  }
  if (timeline.error && !overview) {
    return <Notice text={timeline.error.message} onRetry={timeline.refresh} />;
  }
  if (!overview) {
    return <Notice text={t("reviewScreen.overview.loadingPullRequest")} />;
  }
  return (
    <View style={styles.screen} testID="review-overview">
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.column}>
          <DescriptionCard overview={overview} />
          <ChecksCard {...props} timeline={timeline} overview={overview} />
          <ThreadsCard {...props} timeline={timeline} />
          <CommitsCard overview={overview} />
        </View>
      </ScrollView>
      <FixSelectedBar selection={props.selection} onSelectionChange={props.onSelectionChange} />
    </View>
  );
}

function DescriptionCard({ overview }: { overview: Overview }) {
  const { t } = useTranslation();
  const onLinkPress = useCallback((url: string) => void openExternalUrl(url), []);
  // PR descriptions run long; the card shows the opening and expands on request.
  const [expanded, setExpanded] = useState(false);
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);
  const bodyStyle = useMemo(() => [styles.pad, expanded ? null : styles.clamped], [expanded]);
  const long = overview.body.length > 600;
  return (
    <SettingsSection
      title={t("reviewScreen.overview.description")}
      testID="review-card-description"
    >
      <View style={settingsStyles.card}>
        <View style={bodyStyle}>
          {overview.body.trim() ? (
            <MarkdownRenderer text={overview.body} onLinkPress={onLinkPress} />
          ) : (
            <Text style={styles.muted}>{t("reviewScreen.overview.noDescription")}</Text>
          )}
        </View>
        {long ? (
          <View style={[settingsStyles.rowBorder, styles.more]}>
            <Button
              size="sm"
              variant="ghost"
              onPress={toggleExpanded}
              testID="review-description-toggle"
            >
              {t(expanded ? "reviewScreen.overview.showLess" : "reviewScreen.overview.showMore")}
            </Button>
          </View>
        ) : null}
        <View style={[settingsStyles.rowBorder, styles.facts]}>
          <Fact
            label={t("reviewScreen.overview.factBranch")}
            value={`${overview.headRefName} → ${overview.baseRefName}`}
          />
          <Fact
            label={t("reviewScreen.overview.factMerge")}
            value={t(mergeKey(overview.mergeable))}
          />
          <Fact
            label={t("reviewScreen.overview.factReview")}
            value={t(reviewKey(overview.reviewDecision))}
          />
          {overview.labels.length > 0 ? (
            <Fact
              label={t("reviewScreen.overview.factLabels")}
              value={overview.labels.join(", ")}
            />
          ) : null}
        </View>
      </View>
    </SettingsSection>
  );
}

function ChecksCard({
  source,
  onJumpTo,
  selection,
  onSelectionChange,
  timeline,
  overview,
}: CardProps & { timeline: ReviewTimeline; overview: Overview }) {
  const { t } = useTranslation();
  const trailing = useMemo(
    () => <ChecksBadges sections={timeline.checkSections} />,
    [timeline.checkSections],
  );
  let message: string | null = null;
  if (overview.checksError) message = overview.checksError;
  else if (timeline.checks.length === 0) message = t("reviewScreen.overview.noChecks");
  return (
    <SettingsSection
      title={t("reviewScreen.overview.checks")}
      testID="review-card-checks"
      trailing={trailing}
    >
      <View style={settingsStyles.card}>
        {message ? (
          <Text style={[styles.pad, overview.checksError ? styles.error : styles.muted]}>
            {message}
          </Text>
        ) : (
          <CheckSections
            source={source}
            sections={timeline.checkSections}
            selection={selection}
            onSelectionChange={onSelectionChange}
            onJumpTo={onJumpTo}
          />
        )}
      </View>
    </SettingsSection>
  );
}

function threadsMessage(timeline: ReviewTimeline, shownCount: number, t: TFunction): string | null {
  if (timeline.threadsError) return timeline.threadsError.message;
  if (timeline.threadsLoading) return t("reviewScreen.overview.loadingThreads");
  if (shownCount > 0) return null;
  return t(
    timeline.threads.length === 0
      ? "reviewScreen.overview.noThreads"
      : "reviewScreen.overview.noUnresolved",
  );
}

function ThreadsCard({
  onJumpTo,
  selection,
  onSelectionChange,
  timeline,
}: CardProps & { timeline: ReviewTimeline }) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<ThreadFilter>("unresolved");
  const shown = filterThreads(timeline.threads, filter);
  const message = threadsMessage(timeline, shown.length, t);
  const trailing = useMemo(
    () => (
      <SegmentedControl
        size="sm"
        value={filter}
        onValueChange={setFilter}
        options={[
          {
            value: "unresolved",
            label: t("reviewScreen.overview.filterUnresolved", { count: timeline.unresolvedCount }),
          },
          {
            value: "all",
            label: t("reviewScreen.overview.filterAll", { count: timeline.threads.length }),
          },
        ]}
      />
    ),
    [filter, t, timeline.threads.length, timeline.unresolvedCount],
  );
  return (
    <SettingsSection
      title={t("reviewScreen.overview.threads")}
      testID="review-card-threads"
      trailing={trailing}
    >
      <View style={settingsStyles.card}>
        {message ? (
          <Text style={[styles.pad, timeline.threadsError ? styles.error : styles.muted]}>
            {message}
          </Text>
        ) : (
          <ThreadRows
            threads={shown}
            selection={selection}
            onSelectionChange={onSelectionChange}
            onJumpTo={onJumpTo}
          />
        )}
        {timeline.threadsTruncated ? (
          <Text style={[styles.pad, styles.muted]}>
            {t("reviewScreen.overview.threadsTruncated")}
          </Text>
        ) : null}
      </View>
    </SettingsSection>
  );
}

function CommitsCard({ overview }: { overview: Overview }) {
  const { t } = useTranslation();
  const openCommits = useCallback(
    () => void openExternalUrl(`${overview.url}/commits`),
    [overview.url],
  );
  const range =
    overview.baseSha && overview.headSha
      ? `${overview.baseSha.slice(0, 7)}..${overview.headSha.slice(0, 7)} · `
      : "";
  return (
    <SettingsSection title={t("reviewScreen.overview.commits")} testID="review-card-commits">
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("reviewScreen.overview.commitCount", { count: overview.commitCount })}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {range}
              {t("reviewScreen.overview.commitStats", {
                additions: overview.additions,
                deletions: overview.deletions,
                files: t("reviewScreen.filesCount", { count: overview.changedFiles }),
              })}
            </Text>
          </View>
          <Button size="sm" variant="outline" onPress={openCommits}>
            {t("reviewScreen.overview.openOnForge")}
          </Button>
        </View>
      </View>
    </SettingsSection>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={styles.factValue} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

function mergeKey(value: "MERGEABLE" | "CONFLICTING" | "UNKNOWN") {
  if (value === "MERGEABLE") return "reviewScreen.overview.mergeClean";
  if (value === "CONFLICTING") return "reviewScreen.conflicts";
  return "reviewScreen.overview.mergeUnknown";
}

function reviewKey(value: "approved" | "changes_requested" | "pending" | null) {
  if (value === "approved") return "reviewScreen.decisionApproved";
  if (value === "changes_requested") return "reviewScreen.decisionChanges";
  return "reviewScreen.overview.noDecision";
}

function Notice({ text, onRetry }: { text: string; onRetry?: () => void }) {
  const { t } = useTranslation();
  return (
    <View style={styles.notice} testID="review-overview">
      <Text style={styles.muted}>{text}</Text>
      {onRetry ? (
        <Button size="sm" variant="outline" onPress={onRetry}>
          {t("common.actions.retry")}
        </Button>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, minWidth: 0, minHeight: 0 },
  scroll: { padding: theme.spacing[4] },
  // A reading surface: the cards sit in a centered 720 column like the Settings pages.
  column: { width: "100%", maxWidth: 720, alignSelf: "center" },
  pad: { padding: theme.spacing[4] },
  clamped: { maxHeight: 200, overflow: "hidden" },
  more: {
    alignItems: "flex-start",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  facts: { padding: theme.spacing[4], gap: theme.spacing[2] },
  fact: { flexDirection: "row", gap: theme.spacing[3] },
  factLabel: { width: 72, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  factValue: { flex: 1, color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.base },
  notice: { flex: 1, padding: theme.spacing[6], gap: theme.spacing[3], alignItems: "flex-start" },
}));
