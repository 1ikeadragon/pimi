// Pimi. Apache-2.0.
import type { PimiRecapPeriod } from "@pimi/protocol/pimi-task";
import { ChevronRight, ListChecks } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { DensityIcon } from "@/components/ui/density-icon";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useTasks, type AggregatedTask } from "@/hooks/use-tasks";
import { useTranslation } from "@/i18n/use-translation";
import { pushPimiTask } from "@/navigation/pimi-tasks";
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
const RECAP_PAGE_SIZE = 100;

/** Monday-to-Monday week, local time. */
function weekRange(period: PimiRecapPeriod): { start: Date; end: Date } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const daysSinceMonday = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - daysSinceMonday - (period === "last-week" ? 7 : 0));
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { start, end };
}

export function PimiRecapUsage() {
  const [period, setPeriod] = useState<PimiRecapPeriod>("last-week");
  return (
    <ScrollView style={styles.scroll} testID="pimi-usage-recap">
      <View style={styles.layout}>
        <View style={styles.header}>
          <View style={styles.heading}>
            <Text style={styles.title}>What shipped</Text>
            <Text style={styles.muted}>Tasks marked done.</Text>
          </View>
          <SegmentedControl options={periods} value={period} onValueChange={setPeriod} />
        </View>
        <RecapPeriod key={period} period={period} />
      </View>
    </ScrollView>
  );
}

function RecapPeriod({ period }: { period: PimiRecapPeriod }) {
  const { t } = useTranslation();
  const { loadState, isError, refetch } = useTasks();
  const { start, end } = useMemo(() => weekRange(period), [period]);

  const done = useMemo(() => {
    if (loadState.status !== "loaded") return [];
    return loadState.data
      .filter((task) => {
        if (task.status !== "done" || !task.completedAt) return false;
        const time = Date.parse(task.completedAt);
        return time >= start.getTime() && time < end.getTime();
      })
      .sort((a, b) => Date.parse(b.completedAt ?? "") - Date.parse(a.completedAt ?? ""));
  }, [end, loadState, start]);

  if (loadState.status !== "loaded") {
    if (isError) {
      return (
        <View style={styles.heading}>
          <UsageMessage text="Couldn’t load the recap." />
          <View style={styles.retry}>
            <Button variant="outline" onPress={refetch}>
              Try again
            </Button>
          </View>
        </View>
      );
    }
    return <UsageMessage text="Loading recap…" />;
  }

  const range = rangeFormat.formatRange(start, new Date(end.getTime() - 1));
  const shown = done.slice(0, RECAP_PAGE_SIZE);
  return (
    <>
      <Text style={styles.date} testID="pimi-recap-range">
        {range}
      </Text>
      <View style={styles.groups}>
        <View style={styles.group}>
          <View style={styles.groupHeader}>
            <DensityIcon icon={ListChecks} size="sm" color="foregroundMuted" />
            <Text style={styles.groupTitle}>Done tasks</Text>
            <Text style={styles.count}>{done.length.toLocaleString()}</Text>
          </View>
          {shown.length > 0 ? (
            shown.map((task) => <RecapRow key={`${task.serverId}:${task.id}`} task={task} />)
          ) : (
            <Text style={[styles.muted, styles.groupNote]}>{t("tasks.recap.none")}</Text>
          )}
          {shown.length < done.length ? (
            <Text style={[styles.muted, styles.groupNote]}>
              Showing the latest {shown.length.toLocaleString()} of {done.length.toLocaleString()}.
            </Text>
          ) : null}
        </View>
      </View>
    </>
  );
}

function RecapRow({ task }: { task: AggregatedTask }) {
  const open = useCallback(() => pushPimiTask(task.serverId, task.id), [task.id, task.serverId]);
  return (
    <PressHighlight
      style={styles.row}
      highlightStyle={styles.highlight}
      accessibilityRole="button"
      onPress={open}
    >
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={2}>
          {task.title}
        </Text>
      </View>
      <Text style={styles.muted}>
        {dayFormat.format(new Date(task.completedAt ?? task.updatedAt))}
      </Text>
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
