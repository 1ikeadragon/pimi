// Pimi. PolyForm-Noncommercial-1.0.0.
// The Conversation tab's side facts: review decision, checks in one line, labels. Wide bodies
// show them as a column beside the entries; narrow ones as a single summary line above them.
import { useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "@/i18n/use-translation";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { DecisionChip } from "../chips";
import type { ReviewTimeline } from "../use-review-timeline";

function useFacts(timeline: ReviewTimeline) {
  const { t } = useTranslation();
  return useMemo(() => {
    const count = (id: ReviewTimeline["checkSections"][number]["id"]) =>
      timeline.checkSections.find((section) => section.id === id)?.count ?? 0;
    const failing = count("attention");
    const running = count("running");
    const passed = count("passed") + count("skipped");
    const parts: string[] = [];
    if (failing > 0) parts.push(t("reviewScreen.conversation.checksFailing", { count: failing }));
    if (running > 0) parts.push(t("reviewScreen.conversation.checksRunning", { count: running }));
    if (passed > 0) parts.push(t("reviewScreen.conversation.checksPassed", { count: passed }));
    const viewer = timeline.status?.viewerLatestReview ?? null;
    return {
      decision: timeline.status?.reviewDecision ?? null,
      viewer: viewer ? t(`reviewScreen.conversation.viewer_${viewer}`) : null,
      checks: parts.join(", "),
      labels: timeline.overview?.labels ?? [],
    };
  }, [t, timeline.checkSections, timeline.overview, timeline.status]);
}

export function ConversationAside({
  timeline,
  onOpenChecks,
}: {
  timeline: ReviewTimeline;
  onOpenChecks: () => void;
}) {
  const { t } = useTranslation();
  const facts = useFacts(timeline);
  return (
    <View style={styles.aside} testID="review-conversation-aside">
      <View style={styles.block}>
        <Text style={styles.heading}>{t("reviewScreen.conversation.asideReview")}</Text>
        {facts.decision ? (
          <DecisionChip decision={facts.decision} size="xs" />
        ) : (
          <Text style={styles.muted}>{t("reviewScreen.conversation.noDecision")}</Text>
        )}
        {facts.viewer ? <Text style={styles.muted}>{facts.viewer}</Text> : null}
      </View>
      <View style={styles.block}>
        <Text style={styles.heading}>{t("reviewScreen.conversation.asideChecks")}</Text>
        <Text style={styles.muted}>
          {timeline.checksLoading
            ? t("reviewScreen.conversation.loadingChecks")
            : facts.checks || t("reviewScreen.conversation.noChecks")}
        </Text>
        {timeline.checks.length > 0 ? (
          <View style={styles.button}>
            <Button size="sm" variant="outline" onPress={onOpenChecks}>
              {t("reviewScreen.conversation.viewChecks")}
            </Button>
          </View>
        ) : null}
      </View>
      {facts.labels.length > 0 ? (
        <View style={styles.block}>
          <Text style={styles.heading}>{t("reviewScreen.conversation.asideLabels")}</Text>
          <View style={styles.labels}>
            {facts.labels.map((label) => (
              <StatusBadge key={label} size="xs" variant="muted" label={label} />
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** The aside's facts in one muted line, for a body too narrow to hold a column. */
export function ConversationSummary({ timeline }: { timeline: ReviewTimeline }) {
  const { t } = useTranslation();
  const facts = useFacts(timeline);
  const decision = facts.decision
    ? t(`reviewScreen.conversation.decision_${facts.decision}`)
    : null;
  const line = [decision, timeline.checksLoading ? null : facts.checks, facts.labels.join(", ")]
    .filter((part) => part)
    .join(" · ");
  if (!line) return null;
  return (
    <Text style={styles.summary} testID="review-conversation-summary">
      {line}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  aside: { width: 260, gap: theme.spacing[4] },
  block: {
    gap: theme.spacing[2],
    paddingBottom: theme.spacing[4],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    alignItems: "flex-start",
  },
  heading: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  button: { marginTop: theme.spacing[1] },
  labels: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[1.5] },
  summary: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
