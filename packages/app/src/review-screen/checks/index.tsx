// Pimi. PolyForm-Noncommercial-1.0.0.
// The Checks tab: the pull request's CI, failed first, shards folded, a failing check expands to
// its log tail and annotations. Ticked checks go to the Fix sheet through "Fix N selected".
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "@/i18n/use-translation";
import { settingsStyles } from "@/styles/settings";
import { Notice } from "../notice";
import type { ReviewJumpTo, ReviewSelection, ChangeRequestSource } from "../types";
import type { ReviewTimeline } from "../use-review-timeline";
import { ChecksBadges } from "./badges";
import { FixSelectedBar } from "./fix-selected-bar";
import { CheckSections } from "./sections";

export function ReviewChecks({
  source,
  timeline,
  selection,
  onSelectionChange,
  onJumpTo,
}: {
  source: ChangeRequestSource;
  timeline: ReviewTimeline;
  selection: ReviewSelection;
  onSelectionChange: (next: ReviewSelection) => void;
  onJumpTo: ReviewJumpTo;
}) {
  const { t } = useTranslation();
  if (timeline.checksLoading) return <Notice text={t("reviewScreen.checksTab.loading")} busy />;
  if (timeline.checks.length === 0) {
    // Nothing to list: a failed read can be retried, an empty one is just empty.
    return timeline.checksError ? (
      <Notice text={timeline.checksError} onRetry={timeline.refresh} />
    ) : (
      <Notice text={t("reviewScreen.checksTab.none")} />
    );
  }
  return (
    <View style={styles.root} testID="review-checks">
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.column}>
          <ChecksBadges sections={timeline.checkSections} />
          {timeline.checksError ? <Text style={styles.note}>{timeline.checksError}</Text> : null}
          <View style={settingsStyles.card}>
            <CheckSections
              source={source}
              sections={timeline.checkSections}
              selection={selection}
              onSelectionChange={onSelectionChange}
              onJumpTo={onJumpTo}
            />
          </View>
        </View>
      </ScrollView>
      <FixSelectedBar selection={selection} onSelectionChange={onSelectionChange} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, minWidth: 0, minHeight: 0 },
  scroll: { padding: theme.spacing[6] },
  note: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  column: { width: "100%", maxWidth: 860, alignSelf: "center", gap: theme.spacing[3] },
}));
