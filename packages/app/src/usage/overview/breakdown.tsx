import { useState } from "react";
import { useTranslation } from "@/i18n/use-translation";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { UsageBreakdownRow, UsageGroupBy, UsageRange } from "@pimi/protocol/messages";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { formatCostUsd, formatPercent, formatTokens } from "./format";
import { providerLabel } from "./providers";
import { useUsageBreakdownQuery } from "./queries";

// Rows past this are in the other tabs' long tails; the list area keeps room for this many so a tab
// with fewer rows (Origin has two) does not shrink the card and move what sits below it.
const MAX_ROWS = 6;
const ROWS_MIN_HEIGHT = 380;

type Dimension = "provider" | "model" | "project" | "origin";

export function UsageBreakdown({
  serverId,
  range,
  provider,
}: {
  serverId: string | null;
  range: UsageRange;
  provider: string | null;
}) {
  const { t } = useTranslation();
  const [dimension, setDimension] = useState<Dimension>("model");
  const options: SegmentedControlOption<Dimension>[] = [
    { value: "provider", label: t("usageOverview.breakdown.provider") },
    { value: "model", label: t("usageOverview.breakdown.model") },
    { value: "project", label: t("usageOverview.breakdown.project") },
    { value: "origin", label: t("usageOverview.breakdown.origin") },
  ];
  const query = useUsageBreakdownQuery({ serverId, range, groupBy: dimension, provider });
  const rows = query.data?.rows ?? [];
  const total = query.data?.totals.total ?? 0;
  return (
    <View style={styles.section} testID="usage-breakdown">
      <SegmentedControl options={options} value={dimension} onValueChange={setDimension} />
      <View style={styles.rows}>
        {rows.slice(0, MAX_ROWS).map((row) => (
          <BreakdownRow key={row.key} row={row} total={total} dimension={dimension} />
        ))}
      </View>
    </View>
  );
}

function rowLabel(row: UsageBreakdownRow, dimension: UsageGroupBy, t: (key: string) => string) {
  if (dimension === "provider") return providerLabel(row.key);
  if (dimension === "origin") {
    return row.key === "pimi"
      ? t("usageOverview.breakdown.pimi")
      : t("usageOverview.breakdown.outside");
  }
  return row.label;
}

function BreakdownRow({
  row,
  total,
  dimension,
}: {
  row: UsageBreakdownRow;
  total: number;
  dimension: Dimension;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const share = total === 0 ? 0 : row.usage.total / total;
  const cost = formatCostUsd(row.usage, locale);
  return (
    <View style={styles.row}>
      <View style={styles.rowHead}>
        <Text style={styles.name} numberOfLines={1}>
          {rowLabel(row, dimension, t)}
        </Text>
        <Text style={styles.figures}>
          {[formatTokens(row.usage.total, locale), cost, formatPercent(share, locale)]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      </View>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${Math.max(1, Math.round(share * 100))}%` }]} />
      </View>
      <Text style={styles.split}>
        {[
          ["input", row.usage.input],
          ["cacheRead", row.usage.cacheRead],
          ["cacheWrite", row.usage.cacheWrite],
          ["output", row.usage.output],
          ["reasoning", row.usage.reasoning],
        ]
          .filter(([, value]) => Number(value) > 0)
          .map(
            ([key, value]) =>
              `${t(`usageOverview.tokenTypes.${key}`)} ${formatTokens(Number(value), locale)}`,
          )
          .join(" · ")}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: { gap: theme.spacing[3] },
  rows: { gap: theme.spacing[3], minHeight: ROWS_MIN_HEIGHT },
  row: { gap: theme.spacing[1] },
  rowHead: { flexDirection: "row", justifyContent: "space-between", gap: theme.spacing[3] },
  name: { flexShrink: 1, color: theme.colors.foreground, fontSize: theme.fontSize.base },
  figures: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  track: {
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.surface3,
    overflow: "hidden",
  },
  fill: {
    height: "100%",
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
  },
  split: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
