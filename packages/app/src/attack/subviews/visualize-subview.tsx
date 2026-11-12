import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { AttackGraphCanvas } from "../attack-graph-canvas";
import { buildAttackGraph, buildCoverageMatrix, type GraphNode } from "../attack-graph-model";
import { useAttackFindings, useAttackStore } from "../attack-store";
import { CoverageMatrix } from "../coverage-matrix";
import { useAttackCoverage } from "../use-attack-coverage";
import type { AttackSubviewProps } from "./types";

type VisualizeMode = "graph" | "coverage";

const MODEL_INTERVAL_MS = 1000;

// The picture is rebuilt at most once a second: findings, agents and coverage all push often.
function useThrottled<T>(value: T, intervalMs: number): T {
  const [shown, setShown] = useState(value);
  const latest = useRef(value);
  latest.current = value;
  const lastAt = useRef(Date.now());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const wait = lastAt.current + intervalMs - Date.now();
    if (wait <= 0) {
      lastAt.current = Date.now();
      setShown(value);
      return;
    }
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      lastAt.current = Date.now();
      setShown(latest.current);
    }, wait);
  }, [intervalMs, value]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return shown;
}

export function VisualizeSubview({ serverId, workspaceId, run, agents }: AttackSubviewProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<VisualizeMode>("graph");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const findings = useAttackFindings(serverId, run.id);
  const coverage = useAttackCoverage(serverId, run.id);
  const latest = useMemo(() => ({ agents, findings, coverage }), [agents, findings, coverage]);
  const inputs = useThrottled(latest, MODEL_INTERVAL_MS);

  const graph = useMemo(
    () =>
      buildAttackGraph({
        agents: inputs.agents,
        coverage: inputs.coverage,
        findings: inputs.findings,
        leadLabel: t("attack.subviews.visualize.columns.lead"),
        moreLabel: (count) => t("attack.subviews.visualize.more", { count }),
      }),
    [inputs, t],
  );
  const matrix = useMemo(() => buildCoverageMatrix(inputs), [inputs]);
  const columnLabels = useMemo(
    () =>
      [
        t("attack.subviews.visualize.columns.lead"),
        t("attack.subviews.visualize.columns.agents"),
        t("attack.subviews.visualize.columns.routes"),
        t("attack.subviews.visualize.columns.findings"),
      ] as const,
    [t],
  );
  const modeOptions = useMemo(
    () => [
      {
        value: "graph" as const,
        label: t("attack.subviews.visualize.graph"),
        testID: "attack-visualize-graph",
      },
      {
        value: "coverage" as const,
        label: t("attack.subviews.visualize.coverage"),
        testID: "attack-visualize-coverage",
      },
    ],
    [t],
  );

  const selected = useMemo(
    () => graph.nodes.find((node) => node.id === selectedId) ?? null,
    [graph.nodes, selectedId],
  );
  const onSelect = useCallback((id: string) => {
    setSelectedId((current) => (current === id ? null : id));
  }, []);
  const onOpenAgent = useCallback(
    (agentId: string) => {
      const key = `${serverId}:${workspaceId}`;
      const store = useAttackStore.getState();
      store.setFocus(key, run.id, { agentId, view: "chat" });
      store.setSubview(key, run.id, "overview");
    },
    [run.id, serverId, workspaceId],
  );

  const empty = graph.nodes.length <= 1 && Object.keys(coverage).length === 0;
  return (
    <View style={styles.root} testID="attack-subview-visualize">
      <View style={styles.header}>
        <SegmentedControl
          options={modeOptions}
          value={mode}
          onValueChange={setMode}
          size="sm"
          accessibilityLabel={t("attack.subviews.visualize.label")}
        />
        <Text style={styles.note} numberOfLines={2} testID="attack-coverage-note">
          {t("attack.subviews.visualize.coverageNote")}
        </Text>
      </View>
      {empty ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>{t("attack.subviews.visualize.empty")}</Text>
        </View>
      ) : (
        <ScrollView style={styles.body}>
          {mode === "graph" ? (
            <AttackGraphCanvas
              model={graph}
              columnLabels={columnLabels}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ) : (
            <CoverageMatrix matrix={matrix} />
          )}
        </ScrollView>
      )}
      {mode === "graph" && selected ? (
        <NodeDetail node={selected} onOpenAgent={onOpenAgent} />
      ) : null}
    </View>
  );
}

function NodeDetail({
  node,
  onOpenAgent,
}: {
  node: GraphNode;
  onOpenAgent: (agentId: string) => void;
}) {
  const { t } = useTranslation();
  const agentId = node.agentId;
  const onOpen = useCallback(() => {
    if (agentId) onOpenAgent(agentId);
  }, [agentId, onOpenAgent]);
  let meta: string | null = null;
  if (node.kind === "finding" && node.finding) {
    meta = `${t(`attack.findings.severity.${node.finding.severity}`)} · ${node.finding.route} · ${t(`attack.findings.status.${node.finding.status}`)}`;
  } else if (node.route) {
    meta = [
      t("attack.subviews.visualize.visits", { count: node.route.visits }),
      `${t("attack.subviews.visualize.columns.agents")}: ${node.route.agentCount}`,
      `${t("attack.subviews.visualize.columns.findings")}: ${node.route.findingCount}`,
    ].join(" · ");
  }
  return (
    <View style={styles.detail} testID="attack-graph-detail">
      <View style={styles.detailText}>
        <Text style={styles.detailTitle} numberOfLines={2} selectable>
          {node.label}
        </Text>
        {meta ? (
          <Text style={styles.note} numberOfLines={2}>
            {meta}
          </Text>
        ) : null}
      </View>
      {agentId ? (
        <Button size="sm" variant="outline" onPress={onOpen} testID="attack-graph-open-agent">
          {t("attack.subviews.visualize.openAgent")}
        </Button>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, minHeight: 0 },
  header: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: theme.spacing[3],
    rowGap: theme.spacing[1],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  note: { flexShrink: 1, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  body: { flex: 1, minHeight: 0 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.spacing[6] },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
    padding: theme.spacing[4],
  },
  detail: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderTopWidth: 1,
    borderColor: theme.colors.border,
  },
  detailText: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  detailTitle: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
}));
