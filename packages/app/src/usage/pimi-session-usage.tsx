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
import { useAggregatedAgents, type AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useLastWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSessionStore, type Agent } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { resolveProviderLabel } from "@/utils/provider-definitions";
import { UsageMeter } from "./meter";

const RING_SIZE = 112;
const RING_STROKE = 7;
const TWO_COLUMN_MIN_WIDTH = 710;
const ROW_SELECTED = { selected: true };
const ROW_UNSELECTED = { selected: false };

function sessionKey(agent: AggregatedAgent): string {
  return JSON.stringify([agent.serverId, agent.id]);
}

function sessionName(agent: AggregatedAgent): string {
  return resolveAgentLabel(agent.title) ?? agent.projectPlacement?.workspaceName ?? "Untitled chat";
}

function contextPercent(usage: Agent["lastUsage"]): number | null {
  if (usage?.contextWindowMaxTokens == null || usage.contextWindowUsedTokens == null) return null;
  return getUsagePercentage(usage.contextWindowMaxTokens, usage.contextWindowUsedTokens);
}

export function PimiSessionUsage() {
  const { agents, isInitialLoad } = useAggregatedAgents();
  const recentWorkspace = useLastWorkspaceSelection();
  const [query, setQuery] = useState("");
  const [selection, select] = useState<string | null>(null);
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

function SessionDetail({ agent }: { agent: AggregatedAgent }) {
  const { i18n, t } = useTranslation();
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
  const percent = contextPercent(usage);
  const colors = useCallback(
    (theme: Theme) => ({
      progressColor: getProgressColor(percent ?? 0, theme),
      trackColor: theme.colors.surface3,
    }),
    [percent],
  );
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
  const used = usage?.contextWindowUsedTokens;
  const capacity = usage?.contextWindowMaxTokens;
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
  let contextLabel = t("contextWindow.noData");
  if (used !== undefined && capacity !== undefined) {
    contextLabel = t("contextWindow.tokens", {
      used: number.format(used),
      max: number.format(capacity),
    });
  } else if (used !== undefined) {
    contextLabel = `${number.format(used)} tokens used · capacity unavailable`;
  } else if (capacity !== undefined) {
    contextLabel = `${number.format(capacity)} token capacity · usage unavailable`;
  }

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
        </View>
      </View>
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
