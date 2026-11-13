import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { UsageBreakdownRow } from "@pimi/protocol/messages";
import { useIsCompactFormFactor } from "@/constants/layout";
import { formatTokens, timezoneOffsetMinutes } from "./format";

const DAY_MS = 86_400_000;
const WEEKS_WIDE = 26;
const WEEKS_COMPACT = 12;
const LEVELS = 4;
const LEGEND_LEVELS = [0, 1, 2, 3, 4] as const;

interface Cell {
  day: string;
  total: number;
  level: number;
  future: boolean;
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Weeks of columns, Sunday first, ending with the week that holds today. */
function buildWeeks(rows: readonly UsageBreakdownRow[], weeks: number): Cell[][] {
  const totals = new Map(rows.map((row) => [row.key, row.usage.total]));
  const todayMs = Date.parse(`${dayKey(Date.now() + timezoneOffsetMinutes() * 60_000)}T00:00:00Z`);
  const lastColumnStart = todayMs - new Date(todayMs).getUTCDay() * DAY_MS;
  const firstStart = lastColumnStart - (weeks - 1) * 7 * DAY_MS;
  let peak = 0;
  for (let ms = firstStart; ms <= todayMs; ms += DAY_MS) {
    peak = Math.max(peak, totals.get(dayKey(ms)) ?? 0);
  }
  const columns: Cell[][] = [];
  for (let week = 0; week < weeks; week += 1) {
    const column: Cell[] = [];
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const ms = firstStart + (week * 7 + weekday) * DAY_MS;
      const total = totals.get(dayKey(ms)) ?? 0;
      column.push({
        day: dayKey(ms),
        total,
        level: total === 0 || peak === 0 ? 0 : Math.max(1, Math.ceil((total / peak) * LEVELS)),
        future: ms > todayMs,
      });
    }
    columns.push(column);
  }
  return columns;
}

/** Day grid coloured by tokens, built from plain views so it follows the theme in both modes. */
export function UsageHeatmap({ rows }: { rows: readonly UsageBreakdownRow[] }) {
  const { t, i18n } = useTranslation();
  const compact = useIsCompactFormFactor();
  const columns = useMemo(
    () => buildWeeks(rows, compact ? WEEKS_COMPACT : WEEKS_WIDE),
    [compact, rows],
  );
  const locale = i18n.resolvedLanguage;
  const levelStyles = [styles.level0, styles.level1, styles.level2, styles.level3, styles.level4];
  return (
    <View style={styles.wrap} testID="usage-heatmap">
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.grid}>
          {columns.map((column) => (
            <View key={column[0].day} style={styles.column}>
              {column.map((cell) => (
                <View
                  key={cell.day}
                  style={[styles.cell, cell.future ? styles.future : levelStyles[cell.level]]}
                  accessibilityLabel={
                    cell.future
                      ? undefined
                      : t("usageOverview.heatmap.dayTooltip", {
                          day: cell.day,
                          tokens: formatTokens(cell.total, locale),
                        })
                  }
                  // Web shows this as the native tooltip.
                  {...{
                    title: cell.future
                      ? undefined
                      : `${cell.day}: ${formatTokens(cell.total, locale)}`,
                  }}
                />
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
      <View style={styles.legend}>
        <Text style={styles.legendText}>{t("usageOverview.heatmap.less")}</Text>
        {LEGEND_LEVELS.map((level) => (
          <View key={level} style={[styles.cell, levelStyles[level]]} />
        ))}
        <Text style={styles.legendText}>{t("usageOverview.heatmap.more")}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  wrap: { gap: theme.spacing[2] },
  grid: { flexDirection: "row", gap: 3 },
  column: { gap: 3 },
  cell: { width: 12, height: 12, borderRadius: 2 },
  future: { backgroundColor: "transparent" },
  legend: { flexDirection: "row", alignItems: "center", gap: 3 },
  legendText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginHorizontal: 4,
  },
  level0: { backgroundColor: theme.colors.surface3 },
  level1: { backgroundColor: theme.colors.surface4 },
  level2: { backgroundColor: theme.colors.foregroundExtraMuted },
  level3: { backgroundColor: theme.colors.accentBright },
  level4: { backgroundColor: theme.colors.accent },
}));
