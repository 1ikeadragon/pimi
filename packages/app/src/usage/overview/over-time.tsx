import { useTranslation } from "@/i18n/use-translation";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { UsageRange } from "@pimi/protocol/messages";
import type { ChartNode } from "@pimi/protocol/chat-view";
import { ChartCard } from "@/components/markdown/fence/view";
import { timezoneOffsetMinutes } from "./format";
import { providerLabel } from "./providers";
import { useUsageBreakdownQueries } from "./queries";

export type UsageMetric = "tokens" | "cost";
const DAY_MS = 86_400_000;
const MAX_ALL_TIME_POINTS = 120;

function dayKeys(count: number): string[] {
  const todayMs = Date.parse(
    `${new Date(Date.now() + timezoneOffsetMinutes() * 60_000).toISOString().slice(0, 10)}T00:00:00Z`,
  );
  return Array.from({ length: count }, (_, i) =>
    new Date(todayMs - (count - 1 - i) * DAY_MS).toISOString().slice(0, 10),
  );
}

function hourKeys(): string[] {
  return Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0"));
}

function axisFor(range: UsageRange, seen: ReadonlySet<string>): string[] {
  if (range === "today") return hourKeys();
  if (range === "week") return dayKeys(7);
  if (range === "month") return dayKeys(30);
  return [...seen].sort().slice(-MAX_ALL_TIME_POINTS);
}

/** Daily bars (hourly for Today), one stacked series per provider. */
export function UsageOverTime({
  serverId,
  range,
  metric,
  providers,
}: {
  serverId: string;
  range: UsageRange;
  metric: UsageMetric;
  providers: readonly string[];
}) {
  const { t } = useTranslation();
  const groupBy = range === "today" ? "hour" : "day";
  const queries = useUsageBreakdownQueries(
    providers.map((provider) => ({ serverId, range, groupBy, provider })),
  );
  const loaded = queries.map((query) => query.data);
  const chart = ((): ChartNode | null => {
    if (providers.length === 0 || loaded.some((data) => !data)) return null;
    const seen = new Set<string>();
    for (const data of loaded) for (const row of data?.rows ?? []) seen.add(row.key);
    const axis = axisFor(range, seen);
    if (axis.length === 0) return null;
    const series = providers.map((provider, index) => {
      const byKey = new Map(loaded[index]?.rows.map((row) => [row.key, row.usage]));
      return {
        name: providerLabel(provider),
        values: axis.map((key) => {
          const usage = byKey.get(key);
          if (!usage) return 0;
          return metric === "cost" ? Math.round((usage.costUsd ?? 0) * 100) / 100 : usage.total;
        }),
      };
    });
    const base = {
      type: "chart" as const,
      title: t("usageOverview.overTime.title"),
      unit: metric === "cost" ? "USD" : "tokens",
      labels: axis,
      series,
    };
    return range === "all"
      ? { ...base, kind: "area", stacked: true }
      : { ...base, kind: "bar", stacked: true };
  })();
  if (!chart) return null;
  return (
    <View style={styles.wrap} testID="usage-over-time">
      <ChartCard key={`${range}-${metric}-${providers.join(",")}`} chart={chart} />
      {metric === "cost" ? (
        <Text style={styles.note}>{t("usageOverview.overTime.costHint")}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  wrap: { gap: theme.spacing[2] },
  note: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
