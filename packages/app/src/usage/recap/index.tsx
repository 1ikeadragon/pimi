import { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useTranslation } from "@/i18n/use-translation";
import { UsageMessage } from "../usage-section";
import { formatRange } from "./format";
import { RecapShipped, RecapWork } from "./lists";
import { RecapNarrativeSections, RecapProfile } from "./narrative";
import { recapRange, type RecapPeriod, type RecapRange } from "./period";
import { useRecapQuery, useWriteRecapNarrative } from "./queries";
import { RecapQuestions } from "./questions";

/**
 * Recap: who the user was as a builder over a period. Numbers come from the host's stored chat
 * timelines; the profile, story and advice are written on demand by the host's Recap model.
 */
export function UsageRecap({ serverId }: { serverId: string }) {
  const { t, i18n } = useTranslation();
  const [period, setPeriod] = useState<RecapPeriod>("this-week");
  const periods = useMemo<SegmentedControlOption<RecapPeriod>[]>(
    () => [
      { value: "this-week", label: t("usageRecap.period.thisWeek") },
      { value: "last-week", label: t("usageRecap.period.lastWeek") },
      { value: "this-month", label: t("usageRecap.period.thisMonth") },
      { value: "last-month", label: t("usageRecap.period.lastMonth") },
    ],
    [t],
  );
  const range = useMemo(() => recapRange(period), [period]);
  return (
    <ScrollView style={styles.scroll} testID="pimi-usage-recap">
      <View style={styles.layout}>
        <View style={styles.header}>
          <SegmentedControl options={periods} value={period} onValueChange={setPeriod} />
          <Text style={styles.muted} testID="pimi-recap-range">
            {formatRange(range.startMs, range.endMs, i18n.resolvedLanguage)}
          </Text>
        </View>
        <RecapBody key={`${serverId}:${period}`} serverId={serverId} range={range} />
      </View>
    </ScrollView>
  );
}

function RecapBody({ serverId, range }: { serverId: string; range: RecapRange }) {
  const { t } = useTranslation();
  const query = useRecapQuery(serverId, range);
  const write = useWriteRecapNarrative(serverId, range);
  const { mutate } = write;
  const onWrite = useCallback(() => mutate(), [mutate]);
  const { refetch } = query;
  const retry = useCallback(() => void refetch(), [refetch]);
  const writeState = useMemo(
    () => ({
      pending: write.isPending,
      error: write.error ? write.error.message : null,
      onWrite,
    }),
    [onWrite, write.error, write.isPending],
  );

  if (query.isError) {
    return (
      <View style={styles.stack}>
        <UsageMessage text={t("usageRecap.loadError")} />
        <View style={styles.retry}>
          <Button variant="outline" onPress={retry}>
            {t("usageRecap.retry")}
          </Button>
        </View>
      </View>
    );
  }
  if (!query.data) return <UsageMessage text={t("usageRecap.loading")} />;
  const { stats, narrative } = query.data;
  return (
    <View style={styles.stack}>
      {stats.prompts === 0 ? (
        <UsageMessage text={t("usageRecap.empty")} />
      ) : (
        <>
          <RecapProfile narrative={narrative} write={writeState} />
          <RecapQuestions stats={stats} narrative={narrative} />
          {narrative ? <RecapNarrativeSections narrative={narrative} /> : null}
          <RecapWork serverId={serverId} stats={stats} />
        </>
      )}
      <RecapShipped serverId={serverId} range={range} />
    </View>
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
    alignItems: "center",
    gap: theme.spacing[3],
  },
  stack: { gap: theme.spacing[4] },
  retry: { alignItems: "flex-start" },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
