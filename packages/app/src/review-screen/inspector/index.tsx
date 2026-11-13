// Pimi. Apache-2.0.
// Stream S4 owns this directory: the Threads / Checks inspector beside the Changes tab. Same rows
// as the Overview cards, so a thread or failing check reads the same in both places.
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "@/i18n/use-translation";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { settingsStyles } from "@/styles/settings";
import type { ReviewInspectorProps, ReviewSelection } from "../types";
import { useReviewTimeline, type ReviewTimeline } from "../use-review-timeline";
import { CheckSections } from "./checks";
import { ChecksBadges } from "./checks-badges";
import { FixSelectedBar } from "./fix-selected-bar";
import { ThreadRows, filterThreads, type ThreadFilter } from "./threads";

export function ReviewInspector({
  source,
  tab,
  onTabChange,
  onJumpTo,
  selection,
  onSelectionChange,
}: ReviewInspectorProps) {
  const { t } = useTranslation();
  const timeline = useReviewTimeline(source, { annotations: true });
  const tabOptions = [
    {
      value: "threads" as const,
      label: t("reviewScreen.inspector.tabThreads", { count: timeline.unresolvedCount }),
    },
    { value: "checks" as const, label: t("reviewScreen.inspector.tabChecks") },
  ];
  const blocked = blockedMessage(timeline, t);

  return (
    <View style={styles.root} testID="review-inspector">
      <View style={styles.tabs}>
        <SegmentedControl size="sm" value={tab} onValueChange={onTabChange} options={tabOptions} />
      </View>
      {blocked ? (
        <View style={styles.note}>
          <Text style={blocked.isError ? styles.error : styles.noteText}>{blocked.text}</Text>
          {blocked.retry ? (
            <Button size="sm" variant="outline" onPress={timeline.refresh}>
              {t("common.actions.retry")}
            </Button>
          ) : null}
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scroll}>
          {tab === "threads" ? (
            <ThreadsPane
              timeline={timeline}
              selection={selection}
              onSelectionChange={onSelectionChange}
              onJumpTo={onJumpTo}
            />
          ) : (
            <ChecksPane
              source={source}
              timeline={timeline}
              selection={selection}
              onSelectionChange={onSelectionChange}
              onJumpTo={onJumpTo}
            />
          )}
        </ScrollView>
      )}
      <FixSelectedBar selection={selection} onSelectionChange={onSelectionChange} />
    </View>
  );
}

function blockedMessage(timeline: ReviewTimeline, t: TFunction) {
  if (timeline.noChangeRequest) {
    return { text: t("reviewScreen.overview.noPullRequest"), isError: false, retry: false };
  }
  if (timeline.error && !timeline.overview) {
    return { text: timeline.error.message, isError: true, retry: true };
  }
  return null;
}

function threadsMessage(timeline: ReviewTimeline, shownCount: number, t: TFunction): string | null {
  if (timeline.threadsLoading) return t("reviewScreen.overview.loadingThreads");
  if (timeline.threadsError) return timeline.threadsError.message;
  if (shownCount > 0) return null;
  return t(
    timeline.threads.length === 0
      ? "reviewScreen.overview.noThreads"
      : "reviewScreen.overview.noUnresolved",
  );
}

function ThreadsPane({
  timeline,
  selection,
  onSelectionChange,
  onJumpTo,
}: {
  timeline: ReviewTimeline;
  selection: ReviewSelection;
  onSelectionChange: (next: ReviewSelection) => void;
  onJumpTo: ReviewInspectorProps["onJumpTo"];
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<ThreadFilter>("unresolved");
  const shown = filterThreads(timeline.threads, filter);
  const message = threadsMessage(timeline, shown.length, t);
  const options = [
    { value: "unresolved" as const, label: t("reviewScreen.inspector.filterUnresolved") },
    {
      value: "all" as const,
      label: t("reviewScreen.overview.filterAll", { count: timeline.threads.length }),
    },
  ];
  return (
    <>
      <SegmentedControl size="sm" value={filter} onValueChange={setFilter} options={options} />
      <View style={settingsStyles.card}>
        {message ? (
          <Text style={timeline.threadsError ? styles.error : styles.cardNote}>{message}</Text>
        ) : (
          <ThreadRows
            threads={shown}
            selection={selection}
            onSelectionChange={onSelectionChange}
            onJumpTo={onJumpTo}
          />
        )}
      </View>
    </>
  );
}

function ChecksPane({
  source,
  timeline,
  selection,
  onSelectionChange,
  onJumpTo,
}: {
  source: ReviewInspectorProps["source"];
  timeline: ReviewTimeline;
  selection: ReviewSelection;
  onSelectionChange: (next: ReviewSelection) => void;
  onJumpTo: ReviewInspectorProps["onJumpTo"];
}) {
  const { t } = useTranslation();
  let message: string | null = null;
  if (timeline.checksLoading) message = t("reviewScreen.inspector.loadingChecks");
  else if (timeline.checks.length === 0) message = t("reviewScreen.overview.noChecks");
  return (
    <>
      <ChecksBadges sections={timeline.checkSections} />
      <View style={settingsStyles.card}>
        {message ? (
          <Text style={styles.cardNote}>{message}</Text>
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
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, minWidth: 0, minHeight: 0 },
  tabs: {
    padding: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  scroll: { padding: theme.spacing[3], gap: theme.spacing[3] },
  note: { padding: theme.spacing[4], gap: theme.spacing[3], alignItems: "flex-start" },
  noteText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  cardNote: {
    padding: theme.spacing[4],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.base },
}));
