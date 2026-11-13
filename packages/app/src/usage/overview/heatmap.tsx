import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "@/i18n/use-translation";
import { Text, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { UsageBreakdownRow } from "@pimi/protocol/messages";
import { formatTokens, timezoneOffsetMinutes } from "./format";

const DAY_MS = 86_400_000;
const CELL = 12;
const GAP = 3;
const PITCH = CELL + GAP;
const LABEL_COLUMN = 30;
const MIN_WEEKS = 8;
const MAX_WEEKS = 53;
const LEVELS = 4;
const LEGEND_LEVELS = [0, 1, 2, 3, 4] as const;
const WEEKDAY_LABEL_ROWS = [1, 3, 5];
const MONTH_LABEL_MIN_COLUMNS = 3;

interface Cell {
  day: string;
  total: number;
  level: number;
  future: boolean;
}

interface Week {
  cells: Cell[];
  monthStartDay: string | null;
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Level 1..LEVELS for each active day by rank among the active days. Daily totals span orders of
 * magnitude, so a linear scale against the busiest day leaves every other day looking empty.
 */
function levelsByRank(totals: readonly number[]): Map<number, number> {
  const distinct = [...new Set(totals.filter((total) => total > 0))].sort((a, b) => a - b);
  const levels = new Map<number, number>();
  distinct.forEach((total, index) => {
    const fraction = distinct.length === 1 ? 1 : (index + 1) / distinct.length;
    levels.set(total, Math.max(1, Math.ceil(fraction * LEVELS)));
  });
  return levels;
}

/** Weeks of columns, Sunday first, ending with the week that holds today. */
function buildWeeks(rows: readonly UsageBreakdownRow[], weeks: number): Week[] {
  const totals = new Map(rows.map((row) => [row.key, row.usage.total]));
  const todayMs = Date.parse(`${dayKey(Date.now() + timezoneOffsetMinutes() * 60_000)}T00:00:00Z`);
  const lastColumnStart = todayMs - new Date(todayMs).getUTCDay() * DAY_MS;
  const firstStart = lastColumnStart - (weeks - 1) * 7 * DAY_MS;
  const visible: number[] = [];
  for (let ms = firstStart; ms <= todayMs; ms += DAY_MS) visible.push(totals.get(dayKey(ms)) ?? 0);
  const levels = levelsByRank(visible);
  const columns: Week[] = [];
  for (let week = 0; week < weeks; week += 1) {
    const cells: Cell[] = [];
    let monthStartDay: string | null = null;
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const ms = firstStart + (week * 7 + weekday) * DAY_MS;
      const total = totals.get(dayKey(ms)) ?? 0;
      const day = dayKey(ms);
      if (day.endsWith("-01") || (week === 0 && weekday === 0)) monthStartDay ??= day;
      cells.push({
        day,
        total,
        level: levels.get(total) ?? 0,
        future: ms > todayMs,
      });
    }
    columns.push({ cells, monthStartDay });
  }
  return columns;
}

/** Weeks that fit the width, but no more than the history needs. */
function weeksToShow(width: number, firstDay: string | null): number {
  const fit = Math.floor((width - LABEL_COLUMN + GAP) / PITCH);
  const todayMs = Date.parse(`${dayKey(Date.now() + timezoneOffsetMinutes() * 60_000)}T00:00:00Z`);
  const needed =
    firstDay === null
      ? MIN_WEEKS
      : Math.ceil((todayMs - Date.parse(`${firstDay}T00:00:00Z`)) / (7 * DAY_MS)) + 1;
  return Math.max(4, Math.min(fit, MAX_WEEKS, Math.max(needed, MIN_WEEKS)));
}

/** Day grid coloured by tokens, built from plain views so it follows the theme in both modes. */
export function UsageHeatmap({ rows }: { rows: readonly UsageBreakdownRow[] }) {
  const { t, i18n } = useTranslation();
  const [width, setWidth] = useState(0);
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width),
    [],
  );
  const locale = i18n.resolvedLanguage;
  const firstDay = useMemo(
    () =>
      rows.reduce<string | null>(
        (first, row) => (first === null || row.key < first ? row.key : first),
        null,
      ),
    [rows],
  );
  const levelStyles = [styles.level0, styles.level1, styles.level2, styles.level3, styles.level4];
  const weeks = weeksToShow(width, firstDay);
  const columns = useMemo(() => buildWeeks(rows, weeks), [rows, weeks]);
  const monthLabels = useMemo(() => {
    const format = new Intl.DateTimeFormat(locale, {
      month: "short",
      timeZone: "UTC",
    });
    let lastLabelled = -MONTH_LABEL_MIN_COLUMNS;
    return columns.map((column, index) => {
      if (column.monthStartDay === null || index - lastLabelled < MONTH_LABEL_MIN_COLUMNS)
        return null;
      lastLabelled = index;
      return format.format(new Date(`${column.monthStartDay}T00:00:00Z`));
    });
  }, [columns, locale]);
  const weekdayLabels = useMemo(() => {
    const format = new Intl.DateTimeFormat(locale, {
      weekday: "short",
      timeZone: "UTC",
    });
    // 2024-01-07 is a Sunday.
    return WEEKDAY_LABEL_ROWS.map((row) => format.format(new Date(Date.UTC(2024, 0, 7 + row))));
  }, [locale]);
  return (
    <View style={styles.wrap} testID="usage-heatmap" onLayout={onLayout}>
      <View style={styles.row}>
        <View style={styles.labelColumn} />
        <View style={styles.grid}>
          {columns.map((column, index) => (
            <View key={column.cells[0].day} style={styles.monthSlot}>
              {monthLabels[index] ? (
                <Text style={styles.monthLabel}>{monthLabels[index]}</Text>
              ) : null}
            </View>
          ))}
        </View>
      </View>
      <View style={styles.row}>
        <View style={styles.labelColumn}>
          {Array.from({ length: 7 }, (_, weekday) => (
            <View key={weekday} style={styles.weekdaySlot}>
              {WEEKDAY_LABEL_ROWS.includes(weekday) ? (
                <Text style={styles.monthText} numberOfLines={1}>
                  {weekdayLabels[WEEKDAY_LABEL_ROWS.indexOf(weekday)]}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
        <View style={styles.grid}>
          {columns.map((column) => (
            <View key={column.cells[0].day} style={styles.column}>
              {column.cells.map((cell) => (
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
      </View>
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
  row: { flexDirection: "row" },
  labelColumn: { width: LABEL_COLUMN, gap: GAP },
  grid: { flexDirection: "row", gap: GAP },
  column: { gap: GAP },
  monthSlot: { width: CELL, height: CELL + GAP, overflow: "visible" },
  weekdaySlot: { height: CELL, justifyContent: "center" },
  monthText: {
    color: theme.colors.foregroundMuted,
    fontSize: 10,
  },
  monthLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: 10,
    position: "absolute",
    left: 0,
    width: PITCH * MONTH_LABEL_MIN_COLUMNS,
  },
  cell: { width: CELL, height: CELL, borderRadius: 2 },
  future: { backgroundColor: "transparent" },
  legend: {
    flexDirection: "row",
    alignItems: "center",
    gap: GAP,
    paddingLeft: LABEL_COLUMN,
  },
  legendText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginHorizontal: 4,
  },
  level0: { backgroundColor: theme.colors.surface3 },
  level1: { backgroundColor: theme.colors.accent, opacity: 0.3 },
  level2: { backgroundColor: theme.colors.accent, opacity: 0.5 },
  level3: { backgroundColor: theme.colors.accent, opacity: 0.75 },
  level4: { backgroundColor: theme.colors.accent },
}));
