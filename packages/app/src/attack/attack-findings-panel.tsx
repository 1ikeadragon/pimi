import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { Image, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Wrench } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  type AttackRun,
  type Finding,
  type FindingEvidence,
  type FindingSeverity,
  type FindingStatus,
} from "@pimi/protocol/attack/types";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { confirmDialog } from "@/utils/confirm-dialog";
import { PressHighlight } from "@/components/ui/press-highlight";
import { usePaneContext } from "@/panels/pane-context";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { toErrorMessage } from "@/utils/error-messages";
import {
  useAttackFindings,
  useAttackStore,
  useAttackSync,
  useLatestAttackRun,
  useViewedAttackRun,
} from "./attack-store";
import { formatClock, useAttackRuntimeMs } from "./use-attack-run-clock";
import { useAttackRunAgents } from "./use-attack-run-agents";
import { buildFixPrompt, parseRunProvider } from "./fix-prompt";
import { FixJobLine, queueBatchFix } from "./attack-batch-fix";
import { AttackAuditPanel, useAttackAudit } from "./attack-audit-panel";
import { FindingMergeMenu } from "./attack-finding-merge";
import { AttackAnnotationResults } from "./attack-annotation-results";

// useAttackRuntimeMs needs a run; with none it only reads a stopped placeholder.
const IDLE_RUN: AttackRun = {
  id: "",
  workspaceId: "",
  cwd: "",
  target: "",
  remoteHost: null,
  repoScope: false,
  scopeNotes: "",
  provider: "",
  roster: [],
  disposableTarget: false,
  limits: { maxRuntimeMs: 1, maxTokens: 1 },
  annotations: [],
  onlyAnnotated: false,
  desktopTarget: null,
  allowDesktopInput: false,
  desktopInputStopped: false,
  annotationResults: {},
  spentByAgent: {},
  status: "stopped",
  pausedReason: null,
  leadAgentId: null,
  spent: { runtimeMs: 0, tokens: 0 },
  resumedAt: null,
  startedAt: "",
  updatedAt: "",
  endedAt: null,
};

function runHost(target: string): string {
  try {
    return new URL(target).host;
  } catch {
    return target;
  }
}

const SEVERITIES: readonly FindingSeverity[] = ["blocker", "major", "minor"];

interface FindingsScope {
  serverId: string;
  workspaceId: string;
  /** Batch selection and "Fix selected" need the board's queue pump, so the phone view omits them. */
  batch: boolean;
}

const FindingsScopeContext = createContext<FindingsScope | null>(null);

function useFindingsScope(): FindingsScope {
  const scope = useContext(FindingsScopeContext);
  if (!scope) throw new Error("Findings scope is required");
  return scope;
}

export function AttackFindingsPanel() {
  const { serverId, workspaceId } = usePaneContext();
  return <AttackFindingsView serverId={serverId} workspaceId={workspaceId} batch />;
}

/** The findings list and Audit tab of a workspace's viewed run; the pane and the phone screen share it. */
export function AttackFindingsView({ serverId, workspaceId, batch }: FindingsScope) {
  const scope = useMemo(() => ({ serverId, workspaceId, batch }), [batch, serverId, workspaceId]);
  return (
    <FindingsScopeContext.Provider value={scope}>
      <AttackFindingsBody />
    </FindingsScopeContext.Provider>
  );
}

function AttackFindingsBody() {
  const { t } = useTranslation();
  const { serverId, workspaceId } = useFindingsScope();
  useAttackSync(serverId, workspaceId);
  const run = useViewedAttackRun(serverId, workspaceId);
  const latestRun = useLatestAttackRun(serverId, workspaceId);
  const findings = useAttackFindings(serverId, run?.id ?? null);
  const active = run !== null && (run.status === "running" || run.status === "paused");
  const runAgents = useAttackRunAgents(serverId, run);
  const [tab, setTab] = useState<"findings" | "audit">("findings");
  // The audit log is refetched when the run's status or its findings change.
  const auditKey = useMemo(() => {
    const latest = findings.reduce(
      (at, finding) => (finding.updatedAt > at ? finding.updatedAt : at),
      "",
    );
    return `${run?.status ?? ""}:${findings.length}:${latest}`;
  }, [findings, run?.status]);
  const audit = useAttackAudit({
    serverId,
    runId: run?.id ?? null,
    changeKey: auditKey,
    watch: tab === "audit" && active,
  });
  const tabOptions = useMemo(
    () => [
      {
        value: "findings" as const,
        label: `${t("attack.findings.tabs.findings")} ${findings.length}`,
        testID: "attack-findings-tab-findings",
      },
      {
        value: "audit" as const,
        label: `${t("attack.findings.tabs.audit")} ${audit.entries.length}`,
        testID: "attack-findings-tab-audit",
      },
    ],
    [audit.entries.length, findings.length, t],
  );
  if (!run) return <FindingsList run={null} findings={findings} agentCount={0} past={false} />;
  return (
    <View style={styles.panel}>
      <View style={styles.tabs}>
        <SegmentedControl
          options={tabOptions}
          value={tab}
          onValueChange={setTab}
          size="sm"
          accessibilityLabel={t("attack.findings.tabs.label")}
        />
      </View>
      {tab === "audit" ? (
        <AttackAuditPanel
          run={run}
          entries={audit.entries}
          error={audit.error}
          agents={runAgents}
        />
      ) : (
        <FindingsList
          run={run}
          findings={findings}
          agentCount={runAgents.length}
          past={latestRun !== null && latestRun.id !== run.id}
        />
      )}
    </View>
  );
}

function useBatchSelection(run: AttackRun | null, findings: readonly Finding[]) {
  const { serverId, workspaceId } = useFindingsScope();
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const onToggleSelect = useCallback((findingId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(findingId)) next.add(findingId);
      return next;
    });
  }, []);
  const onSelectOpen = useCallback(() => {
    setSelected(new Set(findings.filter((item) => item.status === "new").map((item) => item.id)));
  }, [findings]);
  const onFixSelected = useCallback(() => {
    if (!run) return;
    queueBatchFix({
      serverId,
      workspaceId,
      run,
      findings: findings.filter((item) => selected.has(item.id)),
    });
    setSelected(new Set());
  }, [findings, run, selected, serverId, workspaceId]);
  return { selected, onToggleSelect, onSelectOpen, onFixSelected };
}

function findingsEmptyText(
  t: (key: string) => string,
  run: AttackRun | null,
  count: number,
  active: boolean,
): string | null {
  if (!run) return t("attack.findings.noRun");
  if (count > 0) return null;
  if (active) return t("attack.findings.running");
  return run.status === "completed"
    ? t("attack.findings.nothingFound")
    : t("attack.findings.empty");
}

function BatchBar({
  selectedCount,
  onSelectOpen,
  onFixSelected,
}: {
  selectedCount: number;
  onSelectOpen: () => void;
  onFixSelected: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.actions} testID="attack-batch-bar">
      <Button size="sm" variant="outline" onPress={onSelectOpen} testID="attack-select-open">
        {t("attack.batchFix.selectOpen")}
      </Button>
      <Button
        size="sm"
        variant="default"
        leftIcon={Wrench}
        onPress={onFixSelected}
        disabled={selectedCount === 0}
        testID="attack-fix-selected"
      >
        {t("attack.batchFix.fixSelected", { count: selectedCount })}
      </Button>
    </View>
  );
}

function FindingsList({
  run,
  findings,
  agentCount,
  past,
}: {
  run: AttackRun | null;
  findings: Finding[];
  agentCount: number;
  /** The run is an older one opened from History, not the newest. */
  past: boolean;
}) {
  const { t } = useTranslation();
  const { batch } = useFindingsScope();
  const { selected, onToggleSelect, onSelectOpen, onFixSelected } = useBatchSelection(
    run,
    findings,
  );
  const grouped = useMemo(() => {
    const bySeverity = new Map<FindingSeverity, Finding[]>();
    for (const finding of findings) {
      const list = bySeverity.get(finding.severity) ?? [];
      list.push(finding);
      bySeverity.set(finding.severity, list);
    }
    for (const list of bySeverity.values()) {
      list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }
    return bySeverity;
  }, [findings]);
  const active = run !== null && (run.status === "running" || run.status === "paused");
  const runtimeMs = useAttackRuntimeMs(run ?? IDLE_RUN);
  const empty = findingsEmptyText(t, run, findings.length, active);
  return (
    <ScrollView contentContainerStyle={styles.content} testID="attack-findings-panel">
      {run && !active ? (
        <Text style={styles.metaText} numberOfLines={1}>
          {t(past ? "attack.findings.pastRun" : "attack.findings.lastRun", {
            target: run.target ? runHost(run.target) : (run.desktopTarget?.appName ?? ""),
          })}
        </Text>
      ) : null}
      {empty ? <Text style={styles.emptyText}>{empty}</Text> : null}
      {run && batch && findings.length > 0 ? (
        <BatchBar
          selectedCount={selected.size}
          onSelectOpen={onSelectOpen}
          onFixSelected={onFixSelected}
        />
      ) : null}
      {run && active && findings.length === 0 ? (
        <Text style={styles.metaText}>
          {t("attack.findings.runningMeta", { count: agentCount, elapsed: formatClock(runtimeMs) })}
        </Text>
      ) : null}
      {run
        ? SEVERITIES.map((severity) => {
            const list = grouped.get(severity);
            if (!list?.length) return null;
            return (
              <View key={severity} style={styles.group} testID={`attack-group-${severity}`}>
                <Text style={styles.groupTitle}>
                  {t(`attack.findings.severity.${severity}`)} · {list.length}
                </Text>
                {list.map((finding) => (
                  <FindingCard
                    key={finding.id}
                    finding={finding}
                    mergeTargets={findings}
                    selected={selected.has(finding.id)}
                    onToggleSelect={onToggleSelect}
                  />
                ))}
              </View>
            );
          })
        : null}
      {run ? <AttackAnnotationResults run={run} findings={findings} /> : null}
    </ScrollView>
  );
}

function FindingCard({
  finding,
  mergeTargets,
  selected,
  onToggleSelect,
}: {
  finding: Finding;
  mergeTargets: readonly Finding[];
  selected: boolean;
  onToggleSelect: (findingId: string) => void;
}) {
  const { t } = useTranslation();
  const { serverId, workspaceId, batch } = useFindingsScope();
  const client = useHostRuntimeClient(serverId);
  const run = useViewedAttackRun(serverId, workspaceId);
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<Finding | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSelect = useCallback(() => onToggleSelect(finding.id), [finding.id, onToggleSelect]);
  const onToggle = useCallback(() => {
    setOpen((value) => !value);
    if (open || detail || !client) return;
    client
      .attackFindingGet({ runId: finding.runId, findingId: finding.id })
      .then((payload) => {
        setDetail(payload.finding);
        return payload.finding;
      })
      .catch((caught: unknown) => setError(toErrorMessage(caught)));
  }, [client, detail, finding.id, finding.runId, open]);

  const setStatus = useCallback(
    async (status: FindingStatus) => {
      if (!client) return;
      setBusy(true);
      setError(null);
      try {
        await client.attackFindingUpdate({
          runId: finding.runId,
          findingId: finding.id,
          status,
        });
      } catch (caught) {
        setError(toErrorMessage(caught));
      } finally {
        setBusy(false);
      }
    },
    [client, finding.id, finding.runId],
  );

  const onMerge = useCallback(
    async (target: Finding) => {
      if (!client) return;
      const confirmed = await confirmDialog({
        title: t("attack.findings.merge.action"),
        message: `${finding.title}\n→ ${target.title}`,
        confirmLabel: t("attack.findings.merge.action"),
      });
      if (!confirmed) return;
      setBusy(true);
      setError(null);
      try {
        await client.attackFindingMerge({
          runId: finding.runId,
          duplicateId: finding.id,
          intoId: target.id,
        });
      } catch (caught) {
        setError(toErrorMessage(caught));
      } finally {
        setBusy(false);
      }
    },
    [client, finding.id, finding.runId, finding.title, t],
  );

  const onFix = useCallback(async () => {
    if (!client || !run) return;
    setBusy(true);
    setError(null);
    try {
      const { provider, model } = parseRunProvider(run.provider);
      const agent = await client.createAgent({
        provider,
        ...(model ? { model } : {}),
        cwd: run.cwd,
        workspaceId,
        title: `Fix: ${finding.title}`.slice(0, 120),
        initialPrompt: buildFixPrompt(run, finding),
      });
      // The board shows the fix agent; no tab is opened for it.
      useAttackStore.getState().setComposing(`${serverId}:${workspaceId}`, null);
      useAttackStore
        .getState()
        .setFocus(`${serverId}:${workspaceId}`, run.id, { agentId: agent.id, view: "chat" });
      await client.attackFindingUpdate({
        runId: finding.runId,
        findingId: finding.id,
        fixAgentId: agent.id,
        status: "triaged",
      });
    } catch (caught) {
      setError(toErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }, [client, finding, run, serverId, workspaceId]);

  const view = detail ?? finding;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <View style={styles.card} testID={`attack-finding-${finding.id}`}>
      <PressHighlight onPress={onToggle} style={styles.cardHeader} testID="attack-finding-toggle">
        <Chevron size={14} color="gray" />
        <View style={styles.cardTitleBlock}>
          <Text style={styles.cardTitle} numberOfLines={open ? undefined : 2}>
            {finding.title}
          </Text>
          <Text style={styles.cardMeta} numberOfLines={1}>
            {finding.route} · {t(`attack.findings.status.${finding.status}`)}
            {finding.reportCount > 1
              ? ` · ${t("attack.findings.reported", { count: finding.reportCount })}`
              : ""}
          </Text>
        </View>
      </PressHighlight>
      {batch ? (
        <View style={styles.selectRow}>
          <Button
            size="sm"
            variant={selected ? "default" : "ghost"}
            onPress={onSelect}
            testID="attack-select-finding"
          >
            {selected ? t("attack.batchFix.selected") : t("attack.batchFix.select")}
          </Button>
        </View>
      ) : null}
      <FixJobLine finding={finding} serverId={serverId} />
      {finding.annotationLabels.length > 0 ? (
        <View style={styles.chips} testID="attack-finding-annotations">
          {finding.annotationLabels.map((label) => (
            <View key={label} style={styles.chip} testID={`attack-finding-chip-${label}`}>
              <Text style={styles.chipText}>{label}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {open ? (
        <View style={styles.cardBody}>
          <Text style={styles.bodyText}>{view.description}</Text>
          <Text style={styles.sectionLabel}>{t("attack.findings.repro")}</Text>
          <Text style={styles.codeText} selectable>
            {view.repro}
          </Text>
          {view.evidence.length > 0 ? (
            <Text style={styles.sectionLabel}>{t("attack.findings.evidence")}</Text>
          ) : null}
          {view.evidence.map((item) => (
            <EvidenceBlock key={evidenceKey(item)} item={item} loaded={detail !== null} />
          ))}
          <View style={styles.actions}>
            <Button
              size="sm"
              variant="default"
              leftIcon={Wrench}
              onPress={onFix as () => void}
              disabled={busy || !run}
              testID="attack-fix-it"
            >
              {t("attack.findings.fixIt")}
            </Button>
            {finding.status !== "triaged" ? (
              <StatusButton
                status="triaged"
                label={t("attack.findings.action.triage")}
                busy={busy}
                onSet={setStatus}
              />
            ) : null}
            {finding.status !== "dismissed" ? (
              <StatusButton
                status="dismissed"
                label={t("attack.findings.action.dismiss")}
                busy={busy}
                onSet={setStatus}
              />
            ) : null}
            {finding.status !== "fixed" ? (
              <StatusButton
                status="fixed"
                label={t("attack.findings.action.fixed")}
                busy={busy}
                onSet={setStatus}
              />
            ) : null}
            {finding.status !== "new" ? (
              <StatusButton
                status="new"
                label={t("attack.findings.action.reopen")}
                busy={busy}
                onSet={setStatus}
              />
            ) : null}
            <FindingMergeMenu
              finding={finding}
              candidates={mergeTargets}
              disabled={busy}
              onMerge={onMerge as (target: Finding) => void}
            />
          </View>
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

function StatusButton({
  status,
  label,
  busy,
  onSet,
}: {
  status: FindingStatus;
  label: string;
  busy: boolean;
  onSet: (status: FindingStatus) => Promise<void>;
}) {
  const onPress = useCallback(() => void onSet(status), [onSet, status]);
  return (
    <Button
      size="sm"
      variant="ghost"
      onPress={onPress}
      disabled={busy}
      testID={`attack-status-${status}`}
    >
      {label}
    </Button>
  );
}

function evidenceKey(item: FindingEvidence): string {
  return item.kind === "screenshot"
    ? `shot:${item.caption}:${item.width}x${item.height}`
    : `${item.kind}:${item.caption}:${item.excerpt.slice(0, 40)}`;
}

function ScreenshotEvidence({ item }: { item: Extract<FindingEvidence, { kind: "screenshot" }> }) {
  const source = useMemo(
    () => ({ uri: `data:image/png;base64,${item.dataBase64 ?? ""}` }),
    [item.dataBase64],
  );
  const style = useMemo(
    () => [
      styles.screenshot,
      { aspectRatio: item.width > 0 && item.height > 0 ? item.width / item.height : 1.6 },
    ],
    [item.height, item.width],
  );
  return (
    <View style={styles.evidence}>
      <Text style={styles.cardMeta}>{item.caption}</Text>
      <Image source={source} style={style} resizeMode="contain" testID="attack-screenshot" />
    </View>
  );
}

function EvidenceBlock({ item, loaded }: { item: FindingEvidence; loaded: boolean }) {
  const { t } = useTranslation();
  if (item.kind === "screenshot") {
    if (item.dataBase64) return <ScreenshotEvidence item={item} />;
    return (
      <Text style={styles.cardMeta}>
        {loaded ? t("attack.findings.screenshotMissing") : t("attack.findings.screenshotLoading")}
      </Text>
    );
  }
  return (
    <View style={styles.evidence}>
      <Text style={styles.cardMeta}>{item.caption}</Text>
      <Text style={styles.codeText} selectable>
        {item.excerpt}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  panel: { flex: 1, minHeight: 0 },
  tabs: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
  },
  content: {
    padding: theme.spacing[3],
    gap: theme.spacing[4],
  },
  metaText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  group: {
    gap: theme.spacing[2],
  },
  groupTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: "500",
  },
  card: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
  },
  cardTitleBlock: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  cardTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: "500",
  },
  cardMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  chip: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  chipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "500",
  },
  cardBody: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[3],
  },
  bodyText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  sectionLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: "500",
  },
  codeText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
  evidence: {
    gap: theme.spacing[1],
  },
  screenshot: {
    width: "100%",
    borderRadius: theme.borderRadius.md,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  selectRow: {
    flexDirection: "row",
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[1],
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
}));
