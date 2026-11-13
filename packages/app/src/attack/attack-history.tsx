import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "@/i18n/use-translation";
import { ArrowLeft, GitCompare, History } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AttackRun, Finding } from "@pimi/protocol/attack/types";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { toErrorMessage } from "@/utils/error-messages";
import { compareRuns } from "./attack-run-compare";
import { useAttackStore } from "./attack-store";
import { formatClock } from "./use-attack-run-clock";

function runLabel(run: AttackRun): string {
  if (run.target) {
    try {
      return new URL(run.target).host;
    } catch {
      return run.target;
    }
  }
  return run.desktopTarget?.appName ?? run.id;
}

function startedLabel(run: AttackRun): string {
  return new Date(run.startedAt).toLocaleString();
}

function useWorkspaceRuns(serverId: string, workspaceId: string): AttackRun[] {
  const runs = useAttackStore((state) => state.byServer[serverId]?.runs);
  return useMemo(
    () =>
      Object.values(runs ?? {})
        .filter((run) => run.workspaceId === workspaceId)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    [runs, workspaceId],
  );
}

/** Past runs of the workspace, newest first: open one, or pick two and compare them. */
export function AttackHistory({
  serverId,
  workspaceId,
  onClose,
}: {
  serverId: string;
  workspaceId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const key = `${serverId}:${workspaceId}`;
  const runs = useWorkspaceRuns(serverId, workspaceId);
  const [picked, setPicked] = useState<string[]>([]);
  const [comparing, setComparing] = useState(false);
  const onOpen = useCallback(
    (runId: string) => {
      const latest = runs[0];
      if (!latest) return;
      const store = useAttackStore.getState();
      store.setViewedRun(key, runId === latest.id ? null : { runId, latestRunId: latest.id });
      store.setHistoryOpen(key, false);
    },
    [key, runs],
  );
  const onTogglePick = useCallback((runId: string) => {
    setComparing(false);
    setPicked((current) => {
      if (current.includes(runId)) return current.filter((id) => id !== runId);
      // A third pick replaces the oldest pick; a comparison takes two.
      return [...current, runId].slice(-2);
    });
  }, []);
  const onCompare = useCallback(() => setComparing(true), []);
  const pickedRuns = useMemo(() => runs.filter((run) => picked.includes(run.id)), [picked, runs]);
  const [newer, older] = pickedRuns;
  return (
    <ScrollView contentContainerStyle={styles.content} testID="attack-history">
      <View style={styles.header}>
        <Button
          size="sm"
          variant="ghost"
          leftIcon={ArrowLeft}
          onPress={onClose}
          testID="attack-history-back"
        >
          {t("attack.history.back")}
        </Button>
        <Text style={styles.title}>{t("attack.history.title", { count: runs.length })}</Text>
        <Button
          size="sm"
          variant="outline"
          leftIcon={GitCompare}
          onPress={onCompare}
          disabled={pickedRuns.length !== 2}
          testID="attack-history-compare"
        >
          {t("attack.history.compare")}
        </Button>
      </View>
      <Text style={styles.hint}>{t("attack.history.pickHint")}</Text>
      {comparing && newer && older ? (
        <RunComparison serverId={serverId} newer={newer} older={older} />
      ) : null}
      {runs.map((run) => (
        <HistoryRow
          key={run.id}
          run={run}
          picked={picked.includes(run.id)}
          onOpen={onOpen}
          onTogglePick={onTogglePick}
        />
      ))}
    </ScrollView>
  );
}

function HistoryRow({
  run,
  picked,
  onOpen,
  onTogglePick,
}: {
  run: AttackRun;
  picked: boolean;
  onOpen: (runId: string) => void;
  onTogglePick: (runId: string) => void;
}) {
  const { t } = useTranslation();
  const open = useCallback(() => onOpen(run.id), [onOpen, run.id]);
  const pick = useCallback(() => onTogglePick(run.id), [onTogglePick, run.id]);
  return (
    <View style={[styles.row, picked && styles.rowPicked]} testID={`attack-history-row-${run.id}`}>
      <PressHighlight onPress={open} style={styles.rowMain} testID="attack-history-open">
        <Text style={styles.rowTitle} numberOfLines={1}>
          {runLabel(run)} · {t(`attack.run.status.${run.status}`)}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {startedLabel(run)} · {formatClock(run.spent.runtimeMs)} ·{" "}
          {Math.round(run.spent.tokens / 1000)}k
        </Text>
      </PressHighlight>
      <Button
        size="sm"
        variant={picked ? "default" : "outline"}
        onPress={pick}
        testID="attack-history-pick"
      >
        {picked ? t("attack.history.picked") : t("attack.history.pick")}
      </Button>
    </View>
  );
}

type LoadedFindings = { findings: Finding[] } | { error: string } | null;

function useRunFindings(serverId: string, runId: string): LoadedFindings {
  const client = useHostRuntimeClient(serverId);
  const [state, setState] = useState<LoadedFindings>(null);
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    setState(null);
    void (async () => {
      try {
        const { findings } = await client.attackFindingList({ runId });
        if (!cancelled) {
          setState({ findings: findings.filter((finding) => finding.duplicateOf === null) });
        }
      } catch (caught) {
        if (!cancelled) setState({ error: toErrorMessage(caught) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, runId]);
  return state;
}

function RunComparison({
  serverId,
  newer,
  older,
}: {
  serverId: string;
  newer: AttackRun;
  older: AttackRun;
}) {
  const { t } = useTranslation();
  const newerLoaded = useRunFindings(serverId, newer.id);
  const olderLoaded = useRunFindings(serverId, older.id);
  const comparison = useMemo(
    () =>
      newerLoaded && olderLoaded && "findings" in newerLoaded && "findings" in olderLoaded
        ? compareRuns(olderLoaded.findings, newerLoaded.findings)
        : null,
    [newerLoaded, olderLoaded],
  );
  const failure = [newerLoaded, olderLoaded].find(
    (value): value is { error: string } => value !== null && "error" in value,
  );
  return (
    <View style={styles.compare} testID="attack-compare">
      <Text style={styles.rowTitle}>
        {t("attack.history.comparing", { older: startedLabel(older), newer: startedLabel(newer) })}
      </Text>
      {failure ? <Text style={styles.errorText}>{failure.error}</Text> : null}
      {!comparison && !failure ? (
        <Text style={styles.rowMeta}>{t("attack.history.loading")}</Text>
      ) : null}
      {comparison ? (
        <>
          <CompareGroup
            testID="attack-compare-added"
            title={t("attack.history.added", { count: comparison.added.length })}
            findings={comparison.added}
          />
          <CompareGroup
            testID="attack-compare-gone"
            title={t("attack.history.gone", { count: comparison.gone.length })}
            findings={comparison.gone}
          />
          <CompareGroup
            testID="attack-compare-still"
            title={t("attack.history.still", { count: comparison.still.length })}
            findings={comparison.still}
          />
          <Text style={styles.rowMeta}>{t("attack.history.compareNote")}</Text>
        </>
      ) : null}
    </View>
  );
}

function CompareGroup({
  title,
  findings,
  testID,
}: {
  title: string;
  findings: Finding[];
  testID: string;
}) {
  return (
    <View style={styles.group} testID={testID}>
      <Text style={styles.groupTitle}>{title}</Text>
      {findings.map((finding) => (
        <Text key={finding.id} style={styles.rowMeta} numberOfLines={2}>
          {finding.severity} · {finding.title} · {finding.route}
        </Text>
      ))}
    </View>
  );
}

/** What the board shows for an older run: its summary, never live tiles. Findings sit in the findings pane. */
export function AttackHistoricRun({
  run,
  onBackToLatest,
  onHistory,
}: {
  run: AttackRun;
  onBackToLatest: () => void;
  onHistory: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.historic} testID="attack-historic-run">
      <History size={20} color="gray" />
      <Text style={styles.title}>
        {t("attack.history.viewing", { target: runLabel(run), started: startedLabel(run) })}
      </Text>
      <Text style={styles.rowMeta}>
        {t(`attack.run.status.${run.status}`)} · {formatClock(run.spent.runtimeMs)} ·{" "}
        {t("attack.history.roles", { count: run.roster.length })}
      </Text>
      <View style={styles.header}>
        <Button size="sm" variant="default" onPress={onBackToLatest} testID="attack-history-latest">
          {t("attack.history.backToLatest")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          leftIcon={History}
          onPress={onHistory}
          testID="attack-history-open-list"
        >
          {t("attack.history.open")}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { padding: theme.spacing[4], gap: theme.spacing[3] },
  header: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2], flexWrap: "wrap" },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.base, fontWeight: "500" },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  rowPicked: { borderColor: theme.colors.palette.red[500] },
  rowMain: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  rowTitle: { color: theme.colors.foreground, fontSize: theme.fontSize.base, fontWeight: "500" },
  rowMeta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  compare: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  group: { gap: theme.spacing[1] },
  groupTitle: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, fontWeight: "500" },
  errorText: { color: theme.colors.palette.red[300], fontSize: theme.fontSize.sm },
  historic: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
}));
