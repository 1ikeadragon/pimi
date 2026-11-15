import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { Play, RotateCcw, Square, Workflow } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { z } from "zod";
import type { AutomationRunStepStatus } from "@pimi/protocol/automation/types";
import { FlowRunStatusSchema, type Flow, type FlowRun } from "@pimi/protocol/flow/types";
import { AutomationCanvasViewport } from "@/components/automations/automation-canvas-viewport";
import {
  AutomationEditorCanvas,
  type CanvasNodeText,
} from "@/components/automations/automation-editor-canvas";
import { readPimiToolOutput } from "@/components/pimi-task-proposal-card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useFetchQuery } from "@/data/query";
import { layoutAutomationGraph } from "@/automations/automation-editor-layout";
import {
  editorStepsFromFlow,
  TRIGGER_NODE_ID,
  type EditorSelection,
} from "@/automations/automation-editor-model";
import { useTranslation } from "@/i18n/use-translation";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { toErrorMessage } from "@/utils/error-messages";
import { flowRunQueryKey, requireFlowClient, useFlow, useFlowMutations } from "./use-flows";

const RUN_POLL_MS = 3000;
const CANVAS_HEIGHT_COMPACT = 300;
const CANVAS_HEIGHT_DESKTOP = 240;
const NO_PROBLEMS = new Map();
const NO_SELECTION: EditorSelection = { kind: "none" };

const RunStart = z.object({ runId: z.string(), status: FlowRunStatusSchema });

/** What `run_flow` returns: the run the card follows. */
export function readFlowRunStart(output: unknown): z.infer<typeof RunStart> | null {
  return readPimiToolOutput(output, RunStart);
}

const STATUS_VARIANT = {
  awaiting_approval: "warning",
  running: "warning",
  succeeded: "success",
  not_met: "error",
  failed: "error",
  cancelled: "muted",
} as const;

function useFlowRun(serverId: string, runId: string) {
  const connected = useHostRuntimeIsConnected(serverId);
  return useFetchQuery({
    queryKey: flowRunQueryKey(serverId, runId),
    enabled: connected,
    dataShape: "value",
    // A finished run does not change until someone retries it, and a retry writes the new run.
    immutableWhen: (run: FlowRun) => run.status !== "running" && run.status !== "awaiting_approval",
    queryFn: async (): Promise<FlowRun> =>
      (await requireFlowClient(serverId).flowRunGet({ runId })).run,
    // Polls only while the run is running.
    refetchInterval: (query) => (query.state.data?.status === "running" ? RUN_POLL_MS : false),
  });
}

/** The chat card for a `run_flow` call: the flow's graph with the run's progress over it. */
export function FlowRunCard({ runId, serverId }: { runId: string; serverId: string }) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const runQuery = useFlowRun(serverId, runId);
  const run = runQuery.data ?? null;
  const flowQuery = useFlow(serverId, run?.flowId);
  const flow = flowQuery.data ?? null;
  const mutations = useFlowMutations(serverId);
  const [pending, setPending] = useState<"run" | "cancel" | "retry" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = useCallback(
    async (kind: "run" | "cancel" | "retry", action: () => Promise<unknown>) => {
      setPending(kind);
      setError(null);
      try {
        await action();
      } catch (cause) {
        setError(toErrorMessage(cause));
      } finally {
        setPending(null);
      }
    },
    [],
  );
  const handleRun = useCallback(
    () =>
      run
        ? void act("run", () => mutations.runApproveAndStart({ flowId: run.flowId, runId: run.id }))
        : undefined,
    [act, mutations, run],
  );
  const handleCancel = useCallback(
    () => void act("cancel", () => mutations.cancelRun(runId)),
    [act, mutations, runId],
  );
  const handleRetry = useCallback(
    () => void act("retry", () => mutations.retryRun(runId)),
    [act, mutations, runId],
  );

  if (!run) {
    return (
      <View style={styles.card} testID="flow-run-card">
        <Text style={styles.muted}>
          {runQuery.isError ? t("flowRun.loadFailed") : t("flows.loading")}
        </Text>
      </View>
    );
  }
  const canRetry =
    run.status === "failed" || run.status === "cancelled" || run.status === "not_met";
  return (
    <View style={styles.card} testID="flow-run-card">
      <View style={styles.header}>
        <Workflow size={16} color={styles.icon.color} />
        <Text accessibilityRole="header" style={styles.title} numberOfLines={1}>
          {t("flowRun.title", { name: run.flowName })}
        </Text>
        <StatusBadge
          label={t(`flowRun.status.${run.status}`)}
          variant={STATUS_VARIANT[run.status]}
        />
      </View>
      {flow ? <RunGraph flow={flow} run={run} serverId={serverId} compact={compact} /> : null}
      <GateFeedback flow={flow} run={run} />
      {run.status === "awaiting_approval" ? (
        <Text style={styles.muted}>{t("flowRun.unapproved")}</Text>
      ) : null}
      {run.status === "not_met" ? (
        <Text style={styles.muted}>{t("flowRun.notMetHint")}</Text>
      ) : null}
      {run.status === "succeeded" && run.output ? (
        <Text style={styles.output} numberOfLines={8} selectable testID="flow-run-output">
          {run.output}
        </Text>
      ) : null}
      {run.error ? (
        <Text style={styles.error} selectable>
          {run.error}
        </Text>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.actions}>
        {run.status === "awaiting_approval" ? (
          <Button
            size="sm"
            leftIcon={Play}
            onPress={handleRun}
            loading={pending === "run"}
            testID="flow-run-start"
          >
            {t("flowRun.run")}
          </Button>
        ) : null}
        {run.status === "running" ? (
          <Button
            size="sm"
            variant="outline"
            leftIcon={Square}
            onPress={handleCancel}
            loading={pending === "cancel"}
            testID="flow-run-cancel"
          >
            {t("flowRun.cancel")}
          </Button>
        ) : null}
        {canRetry ? (
          <Button
            size="sm"
            variant="outline"
            leftIcon={RotateCcw}
            onPress={handleRetry}
            loading={pending === "retry"}
            testID="flow-run-retry"
          >
            {t("flowRun.retry")}
          </Button>
        ) : null}
      </View>
    </View>
  );
}

// The graph is laid out once per flow revision and direction, never per poll, so it holds still
// while step statuses change over it.
function RunGraph({
  flow,
  run,
  serverId,
  compact,
}: {
  flow: Flow;
  run: FlowRun;
  serverId: string;
  compact: boolean;
}) {
  const { t } = useTranslation();
  const direction = compact ? "down" : "right";
  const steps = useMemo(() => editorStepsFromFlow(flow.flow), [flow.flow]);
  const layout = useMemo(
    () => layoutAutomationGraph({ steps, edges: flow.flow.edges, direction }),
    [direction, flow.flow.edges, steps],
  );
  const state = useMemo(
    () => ({
      steps,
      edges: flow.flow.edges,
      selection: NO_SELECTION,
      problemsByTarget: NO_PROBLEMS,
    }),
    [flow.flow.edges, steps],
  );
  const nodeText = useMemo(() => {
    const map = new Map<string, CanvasNodeText>();
    map.set(TRIGGER_NODE_ID, {
      title: t("flowEditor.startNode"),
      subtitle: run.input ? run.input : t("flowEditor.startNodeHint"),
    });
    for (const node of flow.flow.nodes) {
      const step = run.steps.find((candidate) => candidate.nodeId === node.id);
      let subtitle: string;
      if (node.kind === "gate") {
        subtitle = t("flowRun.attempt", { attempt: step?.attempt ?? 0, max: node.maxAttempts });
      } else if (node.kind === "agent") {
        subtitle =
          step?.attempt && step.attempt > 1
            ? t("flowRun.attempt", { attempt: step.attempt, max: step.attempt })
            : `${node.provider}${node.model ? `/${node.model}` : ""}`;
      } else {
        subtitle = "";
      }
      map.set(node.id, { title: node.title || node.id, subtitle });
    }
    return map;
  }, [flow.flow.nodes, run.input, run.steps, t]);
  const runStatuses = useMemo(
    () =>
      new Map<string, AutomationRunStepStatus>(run.steps.map((step) => [step.nodeId, step.status])),
    [run.steps],
  );
  // A tap on a step opens the agent that ran it.
  const handleSelect = useCallback(
    (selection: EditorSelection) => {
      if (selection.kind !== "step") return;
      const agentId = run.steps.find((step) => step.nodeId === selection.id)?.agentId;
      if (agentId) navigateToAgent({ serverId, agentId });
    },
    [run.steps, serverId],
  );
  const frame = compact ? styles.canvasCompact : styles.canvasDesktop;
  return (
    <View style={frame} testID="flow-run-canvas">
      <AutomationCanvasViewport
        width={layout.width}
        height={layout.height}
        topInset={0}
        fitKey={direction}
        reveal={null}
      >
        <AutomationEditorCanvas
          state={state}
          direction={direction}
          layout={layout}
          nodeText={nodeText}
          runStatuses={runStatuses}
          editable={false}
          onSelect={handleSelect}
          onAddAfter={noop}
          onInsert={noop}
          onDisconnect={noop}
          onConnect={noop}
        />
      </AutomationCanvasViewport>
    </View>
  );
}

function noop() {}

// Each gate's latest verdict: what the judge said, so a Not met run shows why without a tap.
function GateFeedback({ flow, run }: { flow: Flow | null; run: FlowRun }) {
  const { t } = useTranslation();
  const lines = run.steps.flatMap((step) => {
    const node = flow?.flow.nodes.find((candidate) => candidate.id === step.nodeId);
    const verdict = step.verdicts?.at(-1);
    if (node?.kind !== "gate" || !verdict) return [];
    return [
      { id: step.nodeId, title: node.title || node.id, step, verdict, max: node.maxAttempts },
    ];
  });
  if (lines.length === 0) return null;
  return (
    <View style={styles.feedback} testID="flow-run-gate-feedback">
      {lines.map((line) => (
        <View key={line.id} style={styles.feedbackRow}>
          <Text style={styles.feedbackTitle}>
            {line.title} ·{" "}
            {t("flowRun.attempt", { attempt: line.step.attempt ?? 1, max: line.max })}
          </Text>
          <Text style={styles.muted} numberOfLines={4} selectable>
            {t("flowRun.feedback", { feedback: line.verdict.feedback })}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    marginVertical: theme.spacing[2],
    padding: theme.spacing[3],
    borderWidth: 1,
    borderRadius: theme.spacing[2],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    gap: theme.spacing[2],
  },
  header: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  icon: { color: theme.colors.foregroundMuted },
  title: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: "600",
  },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  output: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, lineHeight: 20 },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
  canvasCompact: {
    height: CANVAS_HEIGHT_COMPACT,
    overflow: "hidden",
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  canvasDesktop: {
    height: CANVAS_HEIGHT_DESKTOP,
    overflow: "hidden",
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  feedback: { gap: theme.spacing[2] },
  feedbackRow: { gap: 2 },
  feedbackTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "500",
  },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing[2] },
}));
