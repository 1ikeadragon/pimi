import { useTranslation } from "@/i18n/use-translation";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { UsageRange } from "@pimi/protocol/messages";
import type { ChartNode } from "@pimi/protocol/chat-view";
import { ChartCard } from "@/components/markdown/fence/view";
import { timezoneOffsetMinutes } from "./format";
import { providerLabel } from "./providers";
import { useUsageBreakdownQueries } from "./queries";

export type UsageMetric = "tokens" | "cost";
const DAY_MS = 86_400_000;

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

interface AxisSlot {
  // The row key the slot sums: a day, an hour, or a month ("2026-11") that folds its days.
  key: string;
  label: string;
}

/**
 * One slot per bar, with a label that reads on its own: hours for Today, weekday and day for
 * seven days, month and day for thirty, and a month with its year for All time (daily rows fold
 * into months, so a long history stays a handful of bars). Labels are unique, and the chart
 * always keeps the first and the last one.
 */
function axisFor(range: UsageRange, seen: ReadonlySet<string>, locale: string | undefined) {
  const utc = { timeZone: "UTC" } as const;
  if (range === "today") {
    const format = new Intl.DateTimeFormat(locale, { hour: "numeric", ...utc });
    return hourKeys().map((key) => ({
      key,
      label: format.format(new Date(Date.UTC(2000, 0, 1, Number(key)))),
    }));
  }
  if (range === "week") {
    const weekday = new Intl.DateTimeFormat(locale, { weekday: "short", ...utc });
    const day = new Intl.DateTimeFormat(locale, { day: "numeric", ...utc });
    return dayKeys(7).map((key) => {
      const date = new Date(`${key}T00:00:00Z`);
      return { key, label: `${weekday.format(date)} ${day.format(date)}` };
    });
  }
  if (range === "month") {
    const format = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", ...utc });
    return dayKeys(30).map((key) => ({
      key,
      label: format.format(new Date(`${key}T00:00:00Z`)),
    }));
  }
  const format = new Intl.DateTimeFormat(locale, { month: "short", year: "numeric", ...utc });
  const months = [...new Set([...seen].map((day) => day.slice(0, 7)))].sort();
  return months.map(
    (key): AxisSlot => ({
      key,
      label: format.format(new Date(`${key}-01T00:00:00Z`)),
    }),
  );
}

/**
 * Series slots follow this order, not usage rank, so a provider keeps its colour when the
 * ranking flips: chartSeries slot 0 is blue (Codex), slot 1 is orange (Claude).
 */
const PROVIDER_SERIES_ORDER = ["codex", "claude"];

function seriesRank(provider: string): number {
  const rank = PROVIDER_SERIES_ORDER.indexOf(provider);
  return rank === -1 ? PROVIDER_SERIES_ORDER.length : rank;
}

/** Smooth lines over time (hourly for Today), one per provider. */
export function UsageOverTime({
  serverId,
  range,
  metric,
  providers: unordered,
}: {
  serverId: string;
  range: UsageRange;
  metric: UsageMetric;
  providers: readonly string[];
}) {
  const { t, i18n } = useTranslation();
  const providers = [...unordered].sort((a, b) => seriesRank(a) - seriesRank(b));
  const groupBy = range === "today" ? "hour" : "day";
  const queries = useUsageBreakdownQueries(
    providers.map((provider) => ({ serverId, range, groupBy, provider })),
  );
  const loaded = queries.map((query) => query.data);
  const chart = ((): ChartNode | null => {
    if (providers.length === 0 || loaded.some((data) => !data)) return null;
    const seen = new Set<string>();
    for (const data of loaded) for (const row of data?.rows ?? []) seen.add(row.key);
    const axis = axisFor(range, seen, i18n.resolvedLanguage);
    if (axis.length === 0) return null;
    const series = providers.map((provider, index) => {
      const byKey = new Map<string, number>();
      for (const row of loaded[index]?.rows ?? []) {
        const key = range === "all" ? row.key.slice(0, 7) : row.key;
        const value = metric === "cost" ? (row.usage.costUsd ?? 0) : row.usage.total;
        byKey.set(key, (byKey.get(key) ?? 0) + value);
      }
      return {
        name: providerLabel(provider),
        values: axis.map(({ key }) => {
          const value = byKey.get(key) ?? 0;
          return metric === "cost" ? Math.round(value * 100) / 100 : value;
        }),
      };
    });
    const base = {
      type: "chart" as const,
      title: t("usageOverview.overTime.title"),
      unit: metric === "cost" ? "USD" : "tokens",
      labels: axis.map(({ label }) => label),
      series,
    };
    // One line per provider with its own area to the baseline, not stacked, so each line reads as
    // that provider's value.
    return { ...base, kind: "area" as const };
  })();
  if (!chart) return null;
  return (
    <View style={styles.wrap} testID="usage-over-time">
      <ChartCard key={`${range}-${metric}-${providers.join(",")}`} chart={chart} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  wrap: { gap: theme.spacing[2] },
}));
