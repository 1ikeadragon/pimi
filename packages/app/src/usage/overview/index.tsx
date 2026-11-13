import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "@/i18n/use-translation";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { UsageAgentTreeChat, UsageBreakdownRow, UsageRange } from "@pimi/protocol/messages";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { Button } from "@/components/ui/button";
import { UsageMessage } from "../usage-section";
import { UsageBreakdown } from "./breakdown";
import { formatPercent, formatTokens, timezoneOffsetMinutes } from "./format";
import { UsageHeatmap } from "./heatmap";
import { computeInsights, type Insight } from "./insights";
import { UsageInsights } from "./insights-card";
import { UsageOverTime, type UsageMetric } from "./over-time";
import { providerLabel } from "./providers";
import {
  useUsageAgentTreeQuery,
  useUsageBreakdownQuery,
  useUsageRescan,
  type UsageBreakdown as UsageBreakdownData,
} from "./queries";
import { UsageStatTiles } from "./stat-tiles";
import { UsageTopChats } from "./top-chats";

const DAY_MS = 86_400_000;

function currentStreak(dayRows: readonly UsageBreakdownRow[]): number {
  const active = new Set(dayRows.filter((row) => row.usage.total > 0).map((row) => row.key));
  const todayMs = Date.parse(
    `${new Date(Date.now() + timezoneOffsetMinutes() * 60_000).toISOString().slice(0, 10)}T00:00:00Z`,
  );
  // A quiet morning does not break yesterday's streak.
  let cursor = active.has(new Date(todayMs).toISOString().slice(0, 10))
    ? todayMs
    : todayMs - DAY_MS;
  let streak = 0;
  while (active.has(new Date(cursor).toISOString().slice(0, 10))) {
    streak += 1;
    cursor -= DAY_MS;
  }
  return streak;
}

function busiestHourLabel(hourRows: readonly UsageBreakdownRow[], locale: string | undefined) {
  const top = [...hourRows].sort((a, b) => b.usage.total - a.usage.total)[0];
  if (!top || top.usage.total === 0) return null;
  return new Intl.DateTimeFormat(locale, { hour: "numeric" }).format(
    new Date(2000, 0, 1, Number(top.key)),
  );
}

interface OverviewState {
  range: UsageRange;
  metric: UsageMetric;
  provider: string | null;
}

function OverviewControls({
  state,
  providers,
  onRange,
  onMetric,
  onProvider,
}: {
  state: OverviewState;
  providers: readonly string[];
  onRange: (range: UsageRange) => void;
  onMetric: (metric: UsageMetric) => void;
  onProvider: (provider: string | null) => void;
}) {
  const { t } = useTranslation();
  const rangeOptions = useMemo<SegmentedControlOption<UsageRange>[]>(
    () => [
      { value: "today", label: t("usageOverview.range.today") },
      { value: "week", label: t("usageOverview.range.week") },
      { value: "month", label: t("usageOverview.range.month") },
      { value: "all", label: t("usageOverview.range.all") },
    ],
    [t],
  );
  const metricOptions = useMemo<SegmentedControlOption<UsageMetric>[]>(
    () => [
      { value: "tokens", label: t("usageOverview.metric.tokens") },
      { value: "cost", label: t("usageOverview.metric.cost") },
    ],
    [t],
  );
  const providerOptions = useMemo<SegmentedControlOption<string>[]>(
    () => [
      { value: "", label: t("usageOverview.allProviders") },
      ...providers.map((id) => ({ value: id, label: providerLabel(id) })),
    ],
    [providers, t],
  );
  const handleProvider = useCallback(
    (value: string) => onProvider(value === "" ? null : value),
    [onProvider],
  );
  return (
    <View style={styles.controls}>
      <SegmentedControl options={rangeOptions} value={state.range} onValueChange={onRange} />
      <SegmentedControl options={metricOptions} value={state.metric} onValueChange={onMetric} />
      {providers.length > 1 ? (
        <SegmentedControl
          options={providerOptions}
          value={state.provider ?? ""}
          onValueChange={handleProvider}
        />
      ) : null}
    </View>
  );
}

/** The Overview tab: where tokens and money went, over a range, for one host. */
export function UsageOverview({ serverId }: { serverId: string }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const [state, setState] = useState<OverviewState>({
    range: "week",
    metric: "tokens",
    provider: null,
  });
  const { range, provider } = state;
  const setRange = useCallback((next: UsageRange) => setState((s) => ({ ...s, range: next })), []);
  const setMetric = useCallback(
    (next: UsageMetric) => setState((s) => ({ ...s, metric: next })),
    [],
  );
  const setProvider = useCallback(
    (next: string | null) => setState((s) => ({ ...s, provider: next })),
    [],
  );
  const { rescan, scanning: rescanning } = useUsageRescan(serverId);
  useEffect(rescan, [rescan]);

  const everyone = useUsageBreakdownQuery({ serverId, range, groupBy: "provider", provider: null });
  const main = useUsageBreakdownQuery({ serverId, range, groupBy: "provider", provider });
  const tree = useUsageAgentTreeQuery({ serverId, range, provider });
  const providers = useMemo(
    () => (everyone.data?.rows ?? []).map((row) => row.key),
    [everyone.data],
  );
  const insights = useMemo(
    () =>
      main.data && tree.data
        ? computeInsights({
            totals: main.data.totals,
            chats: tree.data,
            formatTokens: (value) => formatTokens(value, locale),
            formatPercent: (fraction) => formatPercent(fraction, locale),
          })
        : [],
    [locale, main.data, tree.data],
  );

  if (main.isError) return <UsageMessage text={t("usageOverview.empty.unavailable")} />;
  if (!main.data) return <UsageMessage text={t("usageOverview.empty.scanning")} />;
  const breakdown = main.data;
  if (breakdown.firstEventAt === null) {
    const busy = breakdown.scanning || rescanning;
    return (
      <View style={styles.stack}>
        <UsageMessage
          text={t(busy ? "usageOverview.empty.scanning" : "usageOverview.empty.noHistory")}
        />
        <Button variant="outline" onPress={rescan}>
          {t("usageOverview.empty.rescan")}
        </Button>
      </View>
    );
  }
  const stale = rescanning || breakdown.scanning;
  return (
    <View style={stale ? styles.stale : undefined} testID="usage-overview">
      <View style={styles.stack}>
        <OverviewControls
          state={state}
          providers={providers}
          onRange={setRange}
          onMetric={setMetric}
          onProvider={setProvider}
        />
        <Text style={styles.muted}>
          {[
            t("usageOverview.empty.startsFrom", {
              date: new Date(breakdown.firstEventAt).toLocaleDateString(locale),
            }),
            stale ? t("usageOverview.empty.scanning") : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
        <OverviewSections
          serverId={serverId}
          state={state}
          providers={providers}
          breakdown={breakdown}
          chats={tree.data ?? []}
          insights={insights}
        />
      </View>
    </View>
  );
}

function OverviewSections({
  serverId,
  state,
  providers,
  breakdown,
  chats,
  insights,
}: {
  serverId: string;
  state: OverviewState;
  providers: readonly string[];
  breakdown: UsageBreakdownData;
  chats: readonly UsageAgentTreeChat[];
  insights: readonly Insight[];
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const { range, metric, provider } = state;
  const days = useUsageBreakdownQuery({ serverId, range: "all", groupBy: "day", provider });
  const hours = useUsageBreakdownQuery({ serverId, range, groupBy: "hour", provider });
  const tools = useUsageBreakdownQuery({ serverId, range, groupBy: "tool", provider });
  const models = useUsageBreakdownQuery({ serverId, range, groupBy: "model", provider });
  const seriesProviders = useMemo(
    () => (provider === null ? providers : [provider]),
    [provider, providers],
  );
  const ask = useMemo(
    () => ({
      serverId,
      range,
      totals: breakdown.totals,
      models: models.data?.rows ?? [],
      chats,
    }),
    [breakdown.totals, chats, models.data, range, serverId],
  );
  return (
    <>
      <UsageStatTiles
        totals={breakdown.totals}
        activeDays={breakdown.activeDays}
        streak={currentStreak(days.data?.rows ?? [])}
        busiestHour={busiestHourLabel(hours.data?.rows ?? [], locale)}
        pricesAsOf={breakdown.prices.asOf}
      />
      {breakdown.totals.total === 0 ? (
        <UsageMessage text={t("usageOverview.empty.noData")} />
      ) : null}
      <Section title={t("usageOverview.heatmap.title")}>
        <UsageHeatmap rows={days.data?.rows ?? []} />
      </Section>
      <UsageOverTime
        serverId={serverId}
        range={range}
        metric={metric}
        providers={seriesProviders}
      />
      <View style={styles.columns}>
        <View style={styles.column}>
          <Section title={t("usageOverview.breakdown.title")}>
            <UsageBreakdown serverId={serverId} range={range} provider={provider} />
          </Section>
        </View>
        <View style={styles.column}>
          <Section title={t("usageOverview.chats.title")}>
            <UsageTopChats chats={chats} serverId={serverId} total={breakdown.totals.total} />
          </Section>
        </View>
      </View>
      <View style={styles.columns}>
        <View style={styles.column}>
          <Section title={t("usageOverview.tools.title")}>
            <ToolRows rows={tools.data?.rows ?? []} />
          </Section>
        </View>
        <View style={styles.column}>
          <Section title={t("usageOverview.insights.title")}>
            <UsageInsights insights={insights} ask={ask} />
          </Section>
        </View>
      </View>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function ToolRows({ rows }: { rows: readonly UsageBreakdownRow[] }) {
  const { t } = useTranslation();
  const peak = Math.max(1, ...rows.map((row) => row.usage.events));
  return (
    <View style={styles.toolRows} testID="usage-tools">
      {rows.slice(0, 10).map((row) => (
        <View key={row.key} style={styles.toolRow}>
          <View style={styles.toolHead}>
            <Text style={styles.toolName} numberOfLines={1}>
              {row.label}
            </Text>
            <Text style={styles.muted}>
              {t("usageOverview.tools.calls", { count: row.usage.events })}
            </Text>
          </View>
          <View style={styles.track}>
            <View
              style={[
                styles.fill,
                { width: `${Math.max(2, Math.round((row.usage.events / peak) * 100))}%` },
              ]}
            />
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  stack: { gap: theme.spacing[6] },
  stale: { opacity: 0.6 },
  controls: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.spacing[3] },
  columns: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[6] },
  column: { flexGrow: 1, flexShrink: 1, flexBasis: 420, minWidth: 0, maxWidth: "100%" },
  section: { gap: theme.spacing[3] },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  toolRows: { gap: theme.spacing[3] },
  toolRow: { gap: theme.spacing[1] },
  toolHead: { flexDirection: "row", justifyContent: "space-between", gap: theme.spacing[3] },
  toolName: { flexShrink: 1, color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  track: { height: 6, borderRadius: 3, backgroundColor: theme.colors.surface3, overflow: "hidden" },
  fill: {
    height: "100%",
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
  },
}));
