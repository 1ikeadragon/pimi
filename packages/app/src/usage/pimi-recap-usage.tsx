// Pimi addition to the Paseo fork. Apache-2.0.
import type { PimiRecap, PimiRecapPeriod } from "@pimi/protocol/pimi-task";
import { ChevronRight, GitMerge, ListChecks } from "lucide-react-native";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { DensityIcon } from "@/components/ui/density-icon";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { getDesktopHost } from "@/desktop/host";
import { UsageMessage } from "./usage-section";

const periods: SegmentedControlOption<PimiRecapPeriod>[] = [
  { value: "last-week", label: "Last week" },
  { value: "this-week", label: "This week" },
];
const rangeFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

export function PimiRecapUsage() {
  const [period, setPeriod] = useState<PimiRecapPeriod>("last-week");
  return (
    <ScrollView style={styles.scroll} testID="pimi-usage-recap">
      <View style={styles.layout}>
        <View style={styles.header}>
          <View style={styles.heading}>
            <Text style={styles.title}>What shipped</Text>
            <Text style={styles.muted}>
              Done tasks and merges from pull requests linked in Pimi.
            </Text>
          </View>
          <SegmentedControl options={periods} value={period} onValueChange={setPeriod} />
        </View>
        <RecapPeriod key={period} period={period} />
      </View>
    </ScrollView>
  );
}

function RecapPeriod({ period }: { period: PimiRecapPeriod }) {
  const read = getDesktopHost()?.getPimiRecap;
  const [recap, setRecap] = useState<PimiRecap>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setFailed(false);
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!read) return;
    let active = true;
    const load = async () => {
      try {
        const value = await read(period);
        if (active) setRecap(value);
      } catch {
        if (active) setFailed(true);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [attempt, period, read]);

  if (!read) return <UsageMessage text="Recap is available in Pimi Desktop." />;
  if (failed) {
    return (
      <View style={styles.heading}>
        <UsageMessage text="Couldn’t load the recap." />
        <View style={styles.retry}>
          <Button variant="outline" onPress={retry}>
            Try again
          </Button>
        </View>
      </View>
    );
  }
  if (!recap) return <UsageMessage text="Loading recap…" />;

  const range = rangeFormat.formatRange(
    new Date(recap.startsAt),
    new Date(Date.parse(recap.endsBefore) - 1),
  );
  return (
    <>
      <Text style={styles.date} testID="pimi-recap-range">
        {range}
      </Text>
      <View style={styles.groups}>
        <RecapGroup
          title="Done tasks"
          icon={ListChecks}
          count={recap.taskCount}
          shown={recap.tasks.length}
          empty="No tasks marked done."
        >
          {recap.tasks.map((task) => (
            <RecapRow
              key={task.id}
              title={task.title}
              time={task.completedAt}
              kind="task"
              target={task.id}
            />
          ))}
        </RecapGroup>
        <RecapGroup
          title="Merged PRs"
          icon={GitMerge}
          count={recap.pullRequestCount}
          shown={recap.pullRequests.length}
          empty="No linked PRs merged."
        >
          {recap.pullRequests.map((pr) => {
            const [, owner, repo, , number] = new URL(pr.url).pathname.split("/");
            const reference = `${owner}/${repo} #${number}`;
            return (
              <RecapRow
                key={pr.url}
                title={pr.title ?? reference}
                subtitle={pr.title ? reference : undefined}
                time={pr.mergedAt}
                kind="review-pr"
                target={pr.url}
              />
            );
          })}
        </RecapGroup>
      </View>
      {recap.hasUndatedCompletions ? (
        <Text style={styles.muted}>
          Entries without a recorded completion or merge date still appear in Tasks.
        </Text>
      ) : null}
    </>
  );
}

function RecapGroup({
  title,
  icon,
  count,
  shown,
  empty,
  children,
}: {
  title: string;
  icon: typeof ListChecks;
  count: number;
  shown: number;
  empty: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.group}>
      <View style={styles.groupHeader}>
        <DensityIcon icon={icon} size="sm" color="foregroundMuted" />
        <Text style={styles.groupTitle}>{title}</Text>
        <Text style={styles.count}>{count.toLocaleString()}</Text>
      </View>
      {shown ? children : <Text style={[styles.muted, styles.groupNote]}>{empty}</Text>}
      {shown < count ? (
        <Text style={[styles.muted, styles.groupNote]}>
          Showing the latest {shown.toLocaleString()} of {count.toLocaleString()}.
        </Text>
      ) : null}
    </View>
  );
}

function RecapRow({
  title,
  subtitle,
  time,
  kind,
  target,
}: {
  title: string;
  subtitle?: string;
  time: string;
  kind: "task" | "review-pr";
  target: string;
}) {
  const open = useCallback(() => {
    const show = getDesktopHost()?.showPimiWorkspace;
    if (kind === "task") show?.({ view: kind, id: target });
    else show?.({ view: kind, url: target });
  }, [kind, target]);
  return (
    <PressHighlight
      style={styles.row}
      highlightStyle={styles.highlight}
      accessibilityRole="button"
      onPress={open}
    >
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={2}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.muted} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      <Text style={styles.muted}>{dayFormat.format(new Date(time))}</Text>
      <DensityIcon icon={ChevronRight} size="sm" color="foregroundMuted" />
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  scroll: { flex: 1 },
  layout: {
    width: "100%",
    maxWidth: 980,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[6],
    paddingBottom: theme.spacing[6],
    gap: theme.spacing[4],
  },
  header: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  heading: { gap: theme.spacing[1] },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.semibold,
  },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  date: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  retry: { alignItems: "flex-start" },
  groups: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[3] },
  group: {
    minWidth: 0,
    maxWidth: "100%",
    flexBasis: 340,
    flexGrow: 1,
    flexShrink: 1,
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  groupHeader: {
    flexDirection: "row",
    alignItems: "center",
    padding: theme.spacing[4],
    gap: theme.spacing[2],
  },
  groupTitle: { flex: 1, color: theme.colors.foreground, fontWeight: theme.fontWeight.semibold },
  count: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  groupNote: { paddingHorizontal: theme.spacing[4], paddingBottom: theme.spacing[4] },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  highlight: { backgroundColor: theme.colors.surface2 },
  rowText: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  rowTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
}));
