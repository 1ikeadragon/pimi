import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentUsage, AgentUsageCounters, AgentUsageSample } from "@pimi/protocol/agent-types";
import type { ChatVisualization } from "@pimi/protocol/chat-visualization";
import { Visualization } from "@/components/markdown/fence/visualization";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";

const COUNTERS = [
  ["Input", "inputTokens"],
  ["Cache read", "cachedInputTokens"],
  ["Cache write", "cacheWriteInputTokens"],
  ["Output", "outputTokens"],
  ["Reasoning", "reasoningOutputTokens"],
  ["Reported total", "reportedTotalTokens"],
] as const satisfies readonly [string, keyof AgentUsageCounters][];

type ReportView = "breakdown" | "trend" | "cost";
const VIEWS: SegmentedControlOption<ReportView>[] = [
  { label: "Breakdown", value: "breakdown" },
  { label: "Over time", value: "trend" },
  { label: "Cost", value: "cost" },
];
const SCOPE_LABELS = {
  request: "Latest request",
  turn: "Latest run",
  session: "Session totals",
} as const;

function reportLabels(samples: AgentUsageSample[], date: Intl.DateTimeFormat) {
  const seen = new Map<string, number>();
  return samples.map(({ capturedAt }) => {
    const label = date.format(new Date(capturedAt));
    const count = (seen.get(label) ?? 0) + 1;
    seen.set(label, count);
    return count === 1 ? label : `${label} · ${count}`;
  });
}

function historyChart(
  samples: AgentUsageSample[],
  date: Intl.DateTimeFormat,
): ChatVisualization | null {
  const candidates = COUNTERS.filter(
    ([, field]) => samples.filter((sample) => sample[field] !== undefined).length >= 2,
  );
  const first = candidates[0];
  if (!first) return null;
  const included = samples.filter((sample) => sample[first[1]] !== undefined);
  const series = candidates
    .filter(([, field]) => included.every((sample) => sample[field] !== undefined))
    .slice(0, 4)
    .map(([name, field]) => ({ name, values: included.map((sample) => sample[field]!) }));
  return {
    type: "line",
    title: "Recorded token reports",
    unit: "tokens",
    labels: reportLabels(included, date),
    series,
  };
}

function buildReport(usage: AgentUsage, locale: string | undefined) {
  const recent = usage.recentSamples ?? [];
  const latest = recent.at(-1);
  const reportedCost = usage.totalCostUsd ?? latest?.totalCostUsd;
  const counts = COUNTERS.flatMap(([name, field]) => {
    const value = usage[field] ?? latest?.[field];
    return typeof value === "number" ? [{ name, value }] : [];
  });
  const breakdown: ChatVisualization | null =
    counts.length > 0
      ? {
          type: "bar",
          title: "Reported tokens",
          unit: "tokens",
          labels: counts.map(({ name }) => name),
          series: [{ name: "Tokens", values: counts.map(({ value }) => value) }],
        }
      : null;
  const date = new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
  const trend = historyChart(recent, date);
  const costs = recent.filter((sample) => sample.totalCostUsd !== undefined);
  const byModel = usage.modelCosts ?? [];
  let cost: ChatVisualization | null = null;
  if (byModel.length) {
    cost = {
      type: "bar",
      title: "Cost by model",
      unit: "USD",
      labels: byModel.map(({ model }) => model),
      series: [{ name: "Reported cost", values: byModel.map(({ usd }) => usd) }],
    };
  } else if (costs.length >= 2) {
    cost = {
      type: "line",
      title: "Recorded cost reports",
      unit: "USD",
      labels: reportLabels(costs, date),
      series: [{ name: "Reported cost", values: costs.map((sample) => sample.totalCostUsd!) }],
    };
  }
  return { reportedCost, counts, breakdown, trend, cost };
}

export function SessionUsageReport({ usage, locale }: { usage: AgentUsage; locale?: string }) {
  const [view, setView] = useState<ReportView>("breakdown");
  const { reportedCost, counts, breakdown, trend, cost } = useMemo(
    () => buildReport(usage, locale),
    [locale, usage],
  );
  const format = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const usd = useMemo(
    () =>
      new Intl.NumberFormat(locale, {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 6,
      }),
    [locale],
  );
  const choices = useMemo(
    () =>
      VIEWS.filter(({ value }) => {
        if (value === "trend") return Boolean(trend);
        if (value === "cost") return Boolean(cost) || reportedCost !== undefined;
        return Boolean(breakdown);
      }),
    [breakdown, cost, reportedCost, trend],
  );
  const selection = choices.some(({ value }) => value === view) ? view : choices[0]?.value;
  const charts = { breakdown, trend, cost };
  const chart = selection ? charts[selection] : null;
  if (!choices.length) return null;
  return (
    <View style={styles.report} testID="pimi-usage-report">
      <Text style={styles.heading}>
        {usage.reportScope ? SCOPE_LABELS[usage.reportScope] : "Latest reported usage"}
      </Text>
      <View style={styles.metrics}>
        {counts.map(({ name, value }) => (
          <View key={name} style={styles.metric}>
            <Text style={styles.muted}>{name}</Text>
            <Text style={styles.value}>{format.format(value)}</Text>
          </View>
        ))}
        {reportedCost !== undefined ? (
          <View style={styles.metric}>
            <Text style={styles.muted}>Reported cost</Text>
            <Text style={styles.value}>{usd.format(reportedCost)}</Text>
          </View>
        ) : null}
      </View>
      {selection && choices.length > 1 ? (
        <SegmentedControl value={selection} onValueChange={setView} options={choices} />
      ) : null}
      {chart ? <Visualization key={selection} chart={chart} /> : null}
      {selection === "trend" ? (
        <Text style={styles.muted}>
          Each point is a provider report. Missing counters are skipped.
        </Text>
      ) : null}
      {selection === "breakdown" ? (
        <Text style={styles.muted}>
          Provider counters can overlap. Use the reported total where available.
        </Text>
      ) : null}
      {selection === "cost" ? (
        <Text style={styles.muted}>Cost comes from the provider’s report. Billing can differ.</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  report: { gap: theme.spacing[3] },
  heading: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
    fontSize: theme.fontSize.sm,
  },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  metrics: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  metric: {
    minWidth: 84,
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  value: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
    fontSize: theme.fontSize.base,
    fontVariant: ["tabular-nums"],
  },
}));
