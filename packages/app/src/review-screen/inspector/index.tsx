// Pimi. Apache-2.0.
// Stream S4 owns this directory: the Threads / Checks inspector beside the Changes tab. Same rows
// as the Overview cards, so a thread or failing check reads the same in both places.
import { useState } from "react";
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

const TAB_OPTIONS_BASE = [{ value: "checks" as const, label: "Checks" }];

export function ReviewInspector({
  source,
  tab,
  onTabChange,
  onJumpTo,
  selection,
  onSelectionChange,
}: ReviewInspectorProps) {
  const timeline = useReviewTimeline(source, { annotations: true });
  const tabOptions = [
    { value: "threads" as const, label: `Threads ${timeline.unresolvedCount}` },
    ...TAB_OPTIONS_BASE,
  ];
  const blocked = blockedMessage(timeline);

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
              Retry
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

function blockedMessage(timeline: ReviewTimeline) {
  if (timeline.noChangeRequest) {
    return { text: "This branch has no pull request yet.", isError: false, retry: false };
  }
  if (timeline.error && !timeline.overview) {
    return { text: timeline.error.message, isError: true, retry: true };
  }
  return null;
}

const FILTER_OPTIONS_BASE = [{ value: "unresolved" as const, label: "Unresolved" }];

function threadsMessage(timeline: ReviewTimeline, shownCount: number): string | null {
  if (timeline.threadsLoading) return "Loading threads…";
  if (timeline.threadsError) return timeline.threadsError.message;
  if (shownCount > 0) return null;
  return timeline.threads.length === 0 ? "No review threads." : "No unresolved threads.";
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
  const [filter, setFilter] = useState<ThreadFilter>("unresolved");
  const shown = filterThreads(timeline.threads, filter);
  const message = threadsMessage(timeline, shown.length);
  const options = [
    ...FILTER_OPTIONS_BASE,
    { value: "all" as const, label: `All ${timeline.threads.length}` },
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
  let message: string | null = null;
  if (timeline.checksLoading) message = "Loading checks…";
  else if (timeline.checks.length === 0) message = "No checks ran on this pull request.";
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
