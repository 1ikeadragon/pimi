import { useTranslation } from "@/i18n/use-translation";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { UsageAggregate } from "@pimi/protocol/messages";
import { UsageGrid } from "./grid";
import { cacheShare, formatCostUsd, formatPercent, formatTokens } from "./format";

interface TileInput {
  totals: UsageAggregate;
  activeDays: number;
  streak: number;
  busiestHour: string | null;
}

export function UsageStatTiles({ totals, activeDays, streak, busiestHour }: TileInput) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const cost = formatCostUsd(totals, locale);
  const share = cacheShare(totals);
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
    <UsageGrid minColumn={150} maxColumns={3} gap={8} testID="usage-overview-tiles">
      {tiles.map((tile) => (
        <View key={tile.id} style={styles.tile} testID={`usage-tile-${tile.id}`}>
          <Text style={styles.label}>{tile.label}</Text>
          <Text style={styles.value}>{tile.value}</Text>
          {tile.note ? <Text style={styles.note}>{tile.note}</Text> : null}
        </View>
      ))}
    </UsageGrid>
  );
}

const styles = StyleSheet.create((theme) => ({
  tile: {
    flex: 1,
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
