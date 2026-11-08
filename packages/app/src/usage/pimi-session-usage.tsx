// Pimi addition to the Paseo fork. Apache-2.0.
import { ArrowUpRight, ChevronRight } from "lucide-react-native";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  FlatList,
  ScrollView,
  Text,
  View,
  type LayoutChangeEvent,
  type ListRenderItem,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useShallow } from "zustand/shallow";
import { resolveAgentLabel } from "@/agent-presentation";
import {
  ContextWindowRing,
  getProgressColor,
  getUsagePercentage,
} from "@/components/context-window-meter";
import { formatContextPercentage } from "@/components/context-window-meter.utils";
import { useProviderIcon } from "@/components/provider-icons";
import { Button } from "@/components/ui/button";
import { DensityIcon } from "@/components/ui/density-icon";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SearchField } from "@/components/ui/search-field";
import { useFetchQuery } from "@/data/query";
import { useAggregatedAgents, type AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useLastWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSessionStore, type Agent } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { resolveProviderLabel } from "@/utils/provider-definitions";
import { UsageMeter } from "./meter";

const RING_SIZE = 112;
const RING_STROKE = 7;
const TWO_COLUMN_MIN_WIDTH = 710;
const COMPACTION_REFRESH_MS = 15_000;
const ROW_SELECTED = { selected: true };
const ROW_UNSELECTED = { selected: false };

function sessionKey(agent: AggregatedAgent): string {
  return JSON.stringify([agent.serverId, agent.id]);
}

function sessionName(agent: AggregatedAgent): string {
  return resolveAgentLabel(agent.title) ?? agent.projectPlacement?.workspaceName ?? "Untitled chat";
}

function contextPercent(usage: Agent["lastUsage"]): number | null {
  if (usage?.contextWindowMaxTokens != null && usage.contextWindowUsedTokens != null) {
    return getUsagePercentage(usage.contextWindowMaxTokens, usage.contextWindowUsedTokens);
  }
  const report = usage?.contextBreakdown;
  return report ? getUsagePercentage(report.capacityTokens, report.usedTokens) : null;
}

export function PimiSessionUsage({
  initialQuery = "",
  initialSessionKey,
}: {
  initialQuery?: string;
  initialSessionKey?: string;
} = {}) {
  const { agents, isInitialLoad } = useAggregatedAgents();
  const recentWorkspace = useLastWorkspaceSelection();
  const [query, setQuery] = useState(initialQuery);
  const [selection, select] = useState<string | null>(initialSessionKey ?? null);
  const [wide, setWide] = useState(false);
  const list = useRef<FlatList<AggregatedAgent>>(null);
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    setWide(event.nativeEvent.layout.width >= TWO_COLUMN_MIN_WIDTH);
  }, []);
  const choose = useCallback(
    (key: string) => {
      select(key);
      if (!wide) list.current?.scrollToOffset({ offset: 0 });
    },
    [wide],
  );
  const search = query.trim().toLowerCase();
  const sessions = useMemo(
    () =>
      search
        ? agents.filter((agent) =>
            [
              sessionName(agent),
              agent.provider,
              agent.projectPlacement?.projectName,
              agent.serverLabel,
            ].some((value) => value?.toLowerCase().includes(search)),
          )
        : agents,
    [agents, search],
  );
  const selected =
    sessions.find((agent) => sessionKey(agent) === selection) ??
    sessions.find(
      (agent) =>
        agent.serverId === recentWorkspace?.serverId &&
        agent.workspaceId === recentWorkspace?.workspaceId,
    ) ??
    sessions[0];
  const selectedKey = selected ? sessionKey(selected) : null;
  const renderItem: ListRenderItem<AggregatedAgent> = useCallback(
    ({ item }) => (
      <SessionRow agent={item} selected={sessionKey(item) === selectedKey} onSelect={choose} />
    ),
    [choose, selectedKey],
  );

  let emptyMessage = "Start a chat to see its usage here.";
  if (search) emptyMessage = "No matching sessions.";
  else if (isInitialLoad) emptyMessage = "Loading sessions…";
  const empty = useMemo(() => <Text style={styles.empty}>{emptyMessage}</Text>, [emptyMessage]);
  const detail = selected ? <SessionDetail agent={selected} /> : null;

  return (
    <View style={styles.layout} onLayout={handleLayout}>
      <View style={styles.search}>
        <SearchField
          value={query}
          onChangeText={setQuery}
          placeholder="Find a session or provider"
          clearAccessibilityLabel="Clear session search"
          testID="pimi-usage-search"
        />
      </View>
      <View style={styles.split}>
        <FlatList
          ref={list}
          data={sessions}
          keyExtractor={sessionKey}
          renderItem={renderItem}
          style={styles.list}
          ListHeaderComponent={wide ? null : detail}
          ListEmptyComponent={empty}
          keyboardShouldPersistTaps="handled"
          testID="pimi-usage-sessions"
        />
        {wide && detail ? <ScrollView style={styles.detailColumn}>{detail}</ScrollView> : null}
      </View>
    </View>
  );
}

const SessionRow = memo(function SessionRow({
  agent,
  selected,
  onSelect,
}: {
  agent: AggregatedAgent;
  selected: boolean;
  onSelect: (key: string) => void;
}) {
  const { i18n } = useTranslation();
  const usage = useSessionStore(
    (state) => state.sessions[agent.serverId]?.agents.get(agent.id)?.lastUsage,
  );
  const percent = contextPercent(usage);
  const ProviderIcon = useProviderIcon(agent.provider, agent.serverId);
  const choose = useCallback(() => onSelect(sessionKey(agent)), [agent, onSelect]);
  const style = useMemo(() => [styles.row, selected && styles.rowSelected], [selected]);
  const subtitle = [agent.provider, agent.projectPlacement?.projectName, agent.serverLabel]
    .filter(Boolean)
    .join(" · ");

  return (
    <PressHighlight
      style={style}
      highlightStyle={styles.rowSelected}
      accessibilityRole="button"
      accessibilityState={selected ? ROW_SELECTED : ROW_UNSELECTED}
      onPress={choose}
      testID={`pimi-usage-session-${agent.id}`}
    >
      <DensityIcon icon={ProviderIcon} size="sm" color="foregroundMuted" />
      <View style={styles.rowTitle}>
        <Text style={styles.rowName} numberOfLines={1}>
          {sessionName(agent)}
        </Text>
        <Text style={styles.muted} numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
      {percent !== null ? (
        <View style={styles.rowMeter}>
          <UsageMeter percent={percent} tone="default" />
          <Text style={styles.muted}>
            {formatContextPercentage(percent, i18n.resolvedLanguage)}
          </Text>
        </View>
      ) : null}
      <DensityIcon icon={ChevronRight} size="sm" color="foregroundMuted" />
    </PressHighlight>
  );
});

function useSessionCompactionCount(serverId: string, agentId: string) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  return useFetchQuery({
    queryKey: ["session-compaction-count", serverId, agentId],
    enabled: client !== null && connected,
    queryFn: async () => {
      if (!client) throw new Error("Host disconnected");
      const result = await client.fetchAgentTimeline(agentId, { compactionSummaryOnly: true });
      return result.completedCompactionCount ?? null;
    },
    dataShape: "value",
    staleTimeMs: COMPACTION_REFRESH_MS,
    refetchOnMount: true,
    refetchInterval: (query) =>
      typeof query.state.data === "number" ? COMPACTION_REFRESH_MS : false,
  });
}

function SessionDetail({ agent }: { agent: AggregatedAgent }) {
  const { i18n } = useTranslation();
  const { usage, model } = useSessionStore(
    useShallow((state) => {
      const current = state.sessions[agent.serverId]?.agents.get(agent.id);
      return {
        usage: current?.lastUsage,
        model: current?.runtimeInfo?.model ?? current?.model,
      };
    }),
  );
  const { entries } = useProvidersSnapshot(agent.serverId, { cwd: agent.cwd });
  const provider = resolveProviderLabel(agent.provider, entries);
  const ProviderIcon = useProviderIcon(agent.provider, agent.serverId);
  const openChat = useCallback(() => {
    navigateToAgent({
      serverId: agent.serverId,
      agentId: agent.id,
      workspaceId: agent.workspaceId,
    });
  }, [agent.id, agent.serverId, agent.workspaceId]);
  const number = useMemo(
    () => new Intl.NumberFormat(i18n.resolvedLanguage),
    [i18n.resolvedLanguage],
  );
  const currency = useMemo(
    () =>
      new Intl.NumberFormat(i18n.resolvedLanguage, {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 6,
      }),
    [i18n.resolvedLanguage],
  );
  const counts = [
    { name: "Input", value: usage?.inputTokens },
    { name: "Cache read", value: usage?.cachedInputTokens },
    { name: "Output", value: usage?.outputTokens },
  ];
  const cost = usage?.totalCostUsd;
  const reported = counts.flatMap(({ name, value }) =>
    value === undefined ? [] : [{ name, value: number.format(value) }],
  );
  if (cost !== undefined) reported.push({ name: "Reported cost", value: currency.format(cost) });
  return (
    <View style={styles.detail} testID="pimi-usage-context">
      <View style={styles.detailHeader}>
        <View style={styles.rowTitle}>
          <Text style={styles.detailTitle} numberOfLines={1}>
            {sessionName(agent)}
          </Text>
          <View style={styles.providerLine}>
            <DensityIcon icon={ProviderIcon} size="sm" color="foregroundMuted" />
            <Text style={styles.muted} numberOfLines={1}>
              {[provider, model].filter(Boolean).join(" · ")}
            </Text>
          </View>
        </View>
        <Button variant="ghost" size="sm" leftIcon={ArrowUpRight} onPress={openChat}>
          Open chat
        </Button>
      </View>
      <SessionContext agent={agent} usage={usage} number={number} />
      {reported.length > 0 ? (
        <>
          <Text style={styles.reportCaption}>Latest reported usage</Text>
          <View style={styles.metrics}>
            {reported.map(({ name, value }) => (
              <View key={name} style={styles.metric}>
                <Text style={styles.muted}>{name}</Text>
                <Text style={styles.metricValue}>{value}</Text>
              </View>
            ))}
          </View>
        </>
      ) : null}
      {agent.provider === "claude" ? (
        <ContextBreakdown report={usage?.contextBreakdown} number={number} />
      ) : null}
    </View>
  );
}

function contextEstimate(usage: Agent["lastUsage"]) {
  if (usage?.contextWindowUsedTokens != null && usage.contextWindowMaxTokens != null) return null;
  return usage?.contextBreakdown ?? null;
}

function SessionContext({
  agent,
  usage,
  number,
}: {
  agent: AggregatedAgent;
  usage: Agent["lastUsage"];
  number: Intl.NumberFormat;
}) {
  const { i18n, t } = useTranslation();
  const compactions = useSessionCompactionCount(agent.serverId, agent.id);
  const percent = contextPercent(usage);
  const colors = useCallback(
    (theme: Theme) => ({
      progressColor: getProgressColor(percent ?? 0, theme),
      trackColor: theme.colors.surface3,
    }),
    [percent],
  );
  const estimate = contextEstimate(usage);
  const used = estimate?.usedTokens ?? usage?.contextWindowUsedTokens;
  const capacity = estimate?.capacityTokens ?? usage?.contextWindowMaxTokens;
  let contextLabel = t("contextWindow.noData");
  if (used !== undefined && capacity !== undefined) {
    contextLabel = t("contextWindow.tokens", {
      used: number.format(used),
      max: number.format(capacity),
    });
    if (estimate) contextLabel += " · estimate";
  } else if (used !== undefined) {
    contextLabel = `${number.format(used)} tokens used · capacity unavailable`;
  } else if (capacity !== undefined) {
    contextLabel = `${number.format(capacity)} token capacity · usage unavailable`;
  }
  let compactionLabel = "Compactions unavailable";
  if (typeof compactions.data === "number") {
    const label = compactions.data === 1 ? "compaction" : "compactions";
    compactionLabel = `${number.format(compactions.data)} ${label} recorded`;
  } else if (compactions.isLoading) {
    compactionLabel = "Counting compactions…";
  }

  return (
    <View style={styles.context}>
      <View style={styles.ring}>
        <ContextWindowRing
          size={RING_SIZE}
          radius={(RING_SIZE - RING_STROKE) / 2}
          strokeWidth={RING_STROKE}
          percentage={percent}
          uniProps={colors}
        />
        <View style={styles.ringLabel}>
          <Text style={styles.percent}>
            {percent === null ? "—" : formatContextPercentage(percent, i18n.resolvedLanguage)}
          </Text>
        </View>
      </View>
      <View style={styles.contextCopy}>
        <Text style={styles.rowName}>{t("contextWindow.title")}</Text>
        <Text style={styles.muted}>{contextLabel}</Text>
        <Text style={styles.muted} testID="pimi-usage-compaction-count">
          {compactionLabel}
        </Text>
      </View>
    </View>
  );
}

function ContextBreakdown({
  report,
  number,
}: {
  report: NonNullable<Agent["lastUsage"]>["contextBreakdown"];
  number: Intl.NumberFormat;
}) {
  return (
    <View style={styles.breakdown} testID="pimi-usage-context-breakdown">
      <Text style={styles.rowName}>Context breakdown</Text>
      {report ? (
        <>
          <Text style={styles.muted}>
            {`${number.format(report.usedTokens)} / ${number.format(report.capacityTokens)} tokens · Last /context estimate`}
          </Text>
          <View style={styles.breakdownRows}>
            {report.categories.map(({ name, tokens, kind }) => (
              <View key={`${kind}:${name}`} style={styles.breakdownRow}>
                <Text style={kind === "used" ? styles.rowName : styles.muted}>{name}</Text>
                <Text style={styles.muted}>{number.format(tokens)}</Text>
              </View>
            ))}
          </View>
        </>
      ) : (
        <Text style={styles.muted}>Run /context in this chat to capture a breakdown.</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  layout: {
    flex: 1,
    minWidth: 0,
    width: "100%",
    maxWidth: 980,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[6],
  },
  search: { flexDirection: "row", paddingBottom: theme.spacing[3] },
  split: { flex: 1, flexDirection: "row", gap: theme.spacing[4] },
  list: { flex: 1, minWidth: 0 },
  detailColumn: { flex: 1.35, minWidth: 0 },
  empty: { paddingVertical: theme.spacing[4], color: theme.colors.foregroundMuted },
  detail: {
    gap: theme.spacing[4],
    padding: theme.spacing[4],
    marginBottom: theme.spacing[4],
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  detailHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  detailTitle: { fontSize: theme.fontSize.lg, color: theme.colors.foreground },
  providerLine: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  context: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[4],
  },
  ring: { width: RING_SIZE, height: RING_SIZE },
  ringLabel: {
    position: "absolute",
    inset: 0,
    alignItems: "center",
    justifyContent: "center",
    pointerEvents: "none",
  },
  contextCopy: { minWidth: 0, flex: 1, gap: theme.spacing[1] },
  percent: {
    fontVariant: ["tabular-nums"],
    fontSize: theme.fontSize["2xl"],
    color: theme.colors.foreground,
  },
  metrics: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  metric: {
    minWidth: 110,
    flexGrow: 1,
    padding: theme.spacing[3],
    gap: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  metricValue: {
    fontVariant: ["tabular-nums"],
    fontSize: theme.fontSize.lg,
    color: theme.colors.foreground,
  },
  reportCaption: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  breakdown: {
    paddingTop: theme.spacing[3],
    borderTopColor: theme.colors.border,
    borderTopWidth: theme.borderWidth[1],
    gap: theme.spacing[2],
  },
  breakdownRows: { gap: theme.spacing[2] },
  breakdownRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  row: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  rowSelected: { backgroundColor: theme.colors.surface2 },
  rowTitle: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  rowName: { fontSize: theme.fontSize.base, color: theme.colors.foreground },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  rowMeter: { width: 60, gap: theme.spacing[1] },
}));
