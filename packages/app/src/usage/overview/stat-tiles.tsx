import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { UsageAggregate } from "@pimi/protocol/messages";
import { cacheShare, formatEstimatedUsd, formatPercent, formatTokens } from "./format";

interface TileInput {
  totals: UsageAggregate;
  activeDays: number;
  streak: number;
  busiestHour: string | null;
  pricesAsOf: string;
}

function describeCost(input: {
  cost: string | null;
  coverage: number;
  pricesAsOf: string;
  locale: string | undefined;
  t: TFunction;
}): string {
  const { cost, coverage, pricesAsOf, locale, t } = input;
  if (cost === null) return t("usageOverview.tiles.costUnknown");
  if (coverage < 0.995) {
    return t("usageOverview.tiles.costPartial", { percent: formatPercent(coverage, locale) });
  }
  return t("usageOverview.tiles.costNote", { date: pricesAsOf });
}

export function UsageStatTiles({ totals, activeDays, streak, busiestHour, pricesAsOf }: TileInput) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const cost = formatEstimatedUsd(totals, locale);
  const share = cacheShare(totals);
  const coverage = totals.total === 0 ? 1 : totals.pricedTokens / totals.total;
  const costNote = describeCost({ cost, coverage, pricesAsOf, locale, t });
  const tiles = [
    {
      id: "tokens",
      label: t("usageOverview.tiles.tokens"),
      value: formatTokens(totals.total, locale),
    },
    {
      id: "cost",
      label: t("usageOverview.tiles.cost"),
      value: cost ?? "—",
      note: costNote,
    },
    {
      id: "cache",
      label: t("usageOverview.tiles.cacheShare"),
      value: share === null ? "—" : formatPercent(share, locale),
    },
    { id: "chats", label: t("usageOverview.tiles.chats"), value: String(totals.chats) },
    {
      id: "days",
      label: t("usageOverview.tiles.activeDays"),
      value: String(activeDays),
      note: t("usageOverview.tiles.streakValue", { count: streak }),
    },
    {
      id: "hour",
      label: t("usageOverview.tiles.busiestHour"),
      value: busiestHour ?? "—",
    },
  ];
  return (
    <View style={styles.grid} testID="usage-overview-tiles">
      {tiles.map((tile) => (
        <View key={tile.id} style={styles.tile} testID={`usage-tile-${tile.id}`}>
          <Text style={styles.label}>{tile.label}</Text>
          <Text style={styles.value}>{tile.value}</Text>
          {tile.note ? <Text style={styles.note}>{tile.note}</Text> : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  grid: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  tile: {
    flexGrow: 1,
    flexBasis: 220,
    minWidth: 160,
    gap: theme.spacing[1],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
  },
  label: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  value: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.semibold,
    fontVariant: ["tabular-nums"],
  },
  note: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
