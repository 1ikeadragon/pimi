import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "@/i18n/use-translation";
import {
  Bot,
  ChevronLeft,
  Copy,
  History,
  MoreHorizontal,
  Pause,
  Play,
  Settings2,
  Sparkles,
  Split,
  Trash2,
  X,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type {
  Automation,
  AutomationEdge,
  AutomationEdgeBranch,
  AutomationRun,
  AutomationRunStepStatus,
} from "@pimi/protocol/automation/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { useDeleteSelectedStep } from "@/components/automations/automation-canvas-input";
import {
  AutomationEditorCanvas,
  problemKey,
  problemParams,
  type CanvasNodeText,
} from "@/components/automations/automation-editor-canvas";
import {
  AutomationEditorInspector,
  type InspectorRunView,
} from "@/components/automations/automation-editor-inspector";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { FormTextInput } from "@/components/ui/form-field";
import { EditingTextInput } from "@/components/ui/text-input";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useFetchQuery } from "@/data/query";
import {
  useAutomationMutations,
  type UseAutomationMutationsResult,
} from "@/hooks/use-automation-mutations";
import { useAutomationDraftActions } from "@/hooks/use-automation-drafts";
import { useAutomations, type AggregatedAutomation } from "@/hooks/use-automations";
import {
  mergeProviderPreferences,
  useFormPreferences,
  type FormPreferences,
} from "@/hooks/use-form-preferences";
import { useProjects } from "@/hooks/use-projects";
import {
  AutomationCanvasViewport,
  type CanvasReveal,
} from "@/components/automations/automation-canvas-viewport";
import { useHosts } from "@/runtime/host-runtime";
import {
  clearAutomationEditorDraft,
  draftKeyFor,
  readAutomationEditorDraft,
} from "@/stores/automation-editor-draft-store";
import { useSessionStore } from "@/stores/session-store";
import {
  buildAutomationEditorDefinition,
  effectiveStepModel,
  modelLabel,
  TRIGGER_NODE_ID,
  type AutomationEditorHost,
  type AutomationEditorModel,
  type AutomationEditorSnapshot,
  type AutomationEditorState,
  type EditorStep,
} from "@/automations/automation-editor-model";
import type { Theme } from "@/styles/theme";
import {
  layoutAutomationGraph,
  NODE_HEIGHT,
  NODE_WIDTH,
} from "@/automations/automation-editor-layout";
import { buildAutomationProjectTargets } from "@/automations/automation-project-targets";
import { AUTOMATION_TEMPLATES } from "@/automations/automation-templates";
import { useAutomationEditorModel } from "@/automations/use-automation-editor-model";
import { everyMsToParts } from "@/utils/automation-format";
import { confirmDialog } from "@/utils/confirm-dialog";
import { getDeviceTimeZone } from "@/utils/device-timezone";
import { toErrorMessage } from "@/utils/error-messages";
import {
  buildAutomationEditorRoute,
  buildAutomationsRoute,
  buildNewAutomationRoute,
} from "@/utils/host-routes";

export interface AutomationEditorScreenProps {
  mode: "create" | "edit";
  serverId?: string;
  automationId?: string;
  templateId?: string;
  duplicateId?: string;
  describe?: boolean;
}

const INSPECTOR_WIDTH = 380;

/**
 * The automation editor: the step graph on a canvas, the selected node's settings beside it (a
 * sheet on a phone), and the automation's actions in the bar above. Opened for a new automation, a
 * template, a description, a duplicate, or an existing automation.
 */
export function AutomationEditorScreen(props: AutomationEditorScreenProps): ReactElement {
  const { t } = useTranslation();
  const { loadState } = useAutomations();
  const needsStored = props.mode === "edit" || Boolean(props.duplicateId);
  const storedId = props.mode === "edit" ? props.automationId : props.duplicateId;
  const found = useMemo(() => {
    if (!needsStored || loadState.status !== "loaded") return null;
    return (
      loadState.data.find(
        (candidate) =>
          candidate.id === storedId && (!props.serverId || candidate.serverId === props.serverId),
      ) ?? null
    );
  }, [loadState, needsStored, props.serverId, storedId]);
  // The list refetches with the connection (a reconnect leaves "loaded"), and an editor that
  // unmounts discards its unsaved edits. Once the automation has been found, keep it.
  const latched = useRef<AggregatedAutomation | null>(null);
  if (found) latched.current = found;
  const stored = found ?? latched.current;
  // Unsaved edits live in a store, so the editor reopens on them. Discarding clears them and
  // remounts the editor on the stored automation.
  const draftKey = draftKeyFor({
    serverId: props.serverId,
    automationId: props.mode === "edit" ? props.automationId : undefined,
    origin: `new:${props.templateId ?? ""}:${props.duplicateId ?? ""}`,
  });
  const [discardCount, setDiscardCount] = useState(0);
  const discardDraft = useCallback(() => {
    clearAutomationEditorDraft(draftKey);
    setDiscardCount((count) => count + 1);
  }, [draftKey]);

  let body: ReactElement;
  if (needsStored && !stored && loadState.status !== "loaded") {
    body = (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={styles.spinner.color} />
      </View>
    );
  } else if (needsStored && !stored) {
    body = (
      <View style={styles.centered}>
        <Text style={styles.muted}>{t("automationEditor.errors.notFound")}</Text>
        <BackButton />
      </View>
    );
  } else {
    body = (
      <AutomationEditor
        key={`${draftKey}#${discardCount}`}
        {...props}
        stored={stored}
        draftKey={draftKey}
        onDiscard={discardDraft}
      />
    );
  }
  return <View style={styles.container}>{body}</View>;
}

function BackButton(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const goBack = useCallback(() => router.replace(buildAutomationsRoute()), [router]);
  return (
    <Button variant="ghost" leftIcon={ChevronLeft} onPress={goBack} testID="automation-editor-back">
      {t("automationEditor.back")}
    </Button>
  );
}

function updateSelectionPreferences(
  preferences: FormPreferences,
  state: AutomationEditorState,
): FormPreferences {
  const { provider, model, modeId, thinkingOptionId } = state.defaults;
  if (!provider) {
    return preferences;
  }
  const firstAgent = state.steps.find((step) => step.kind === "agent");
  return {
    ...mergeProviderPreferences({
      preferences,
      provider,
      updates: {
        model: model.trim() || undefined,
        mode: modeId.trim() || undefined,
        ...(model && thinkingOptionId ? { thinkingByModel: { [model]: thinkingOptionId } } : {}),
      },
    }),
    ...(firstAgent?.kind === "agent"
      ? { isolation: firstAgent.workspace === "worktree" ? "worktree" : "local" }
      : {}),
  };
}

function useShownRun(input: {
  serverId: string;
  automationId: string | undefined;
  runId: string | undefined;
}): AutomationRun | null {
  const { serverId, automationId, runId } = input;
  const query = useFetchQuery({
    queryKey: ["automation-run", serverId, automationId, runId],
    enabled: Boolean(serverId && automationId && runId),
    dataShape: "value",
    immutableWhen: (run: AutomationRun) => run.status !== "running",
    queryFn: async (): Promise<AutomationRun> => {
      const client = useSessionStore.getState().sessions[serverId]?.client;
      if (!client || !automationId || !runId) {
        throw new Error("Host is not connected");
      }
      return (await client.automationRunGet({ automationId, runId })).run;
    },
    refetchInterval: (current) => (current.state.data?.status === "running" ? 3000 : false),
  });
  return query.data ?? null;
}

function useRunList(serverId: string, automationId: string | undefined) {
  return useFetchQuery({
    queryKey: ["automation-runs", serverId, automationId],
    enabled: Boolean(serverId && automationId),
    dataShape: "list",
    staleTimeMs: 5000,
    queryFn: async (): Promise<AutomationRun[]> => {
      const client = useSessionStore.getState().sessions[serverId]?.client;
      if (!client || !automationId) {
        throw new Error("Host is not connected");
      }
      return (await client.automationRunList({ automationId, limit: 20 })).runs;
    },
  });
}

function AutomationEditor({
  mode,
  serverId,
  templateId,
  describe,
  stored,
  draftKey,
  onDiscard,
}: AutomationEditorScreenProps & {
  stored: AggregatedAutomation | null;
  draftKey: string;
  onDiscard: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const { snapshot, updatePreferences } = useEditorSnapshot({
    mode,
    serverId,
    templateId,
    stored,
    draftKey,
  });
  const { model, state, providers } = useAutomationEditorModel(snapshot, draftKey);
  const automation = mode === "edit" ? stored : null;
  const mutationServerId = state.selectedServerId ?? "";
  const mutations = useAutomationMutations({ serverId: mutationServerId });
  const [describeOpen, setDescribeOpen] = useState(Boolean(describe));
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The palette floats over the canvas; a fitted graph stays below it.
  const [paletteInset, setPaletteInset] = useState(0);

  const runs = useEditorRuns({
    serverId: mutationServerId,
    automation,
    retryAutomationRun: mutations.retryAutomationRun,
    retrying: mutations.isRetrying,
  });
  const { runId, setRunId, showRun, setShowRun, runList, runView, runStatuses } = runs;

  const { saving, handleSave } = useEditorSave({
    model,
    state,
    automation,
    serverId: mutationServerId,
    mutations,
    updatePreferences,
  });

  const actions = useEditorActions({
    automation,
    mutations,
    draftKey,
    onRunStarted: runs.showStartedRun,
  });
  const {
    actionError,
    handleApprove,
    handleRunNow,
    handlePauseResume,
    handleDuplicate,
    handleDelete,
  } = actions;
  const openDescribe = useCallback(() => setDescribeOpen(true), []);
  const closeDescribe = useCallback(() => setDescribeOpen(false), []);
  // A described automation drafts in the background and shows up in the list.
  const router = useRouter();
  const leaveForList = useCallback(() => router.replace(buildAutomationsRoute()), [router]);
  const openSettings = useCallback(() => {
    model.select({ kind: "none" });
    setSettingsOpen(true);
  }, [model]);

  // Canvas
  const nodeText = useNodeText(state);
  const { handleAddAfter, handleInsert, handleConnect, linkRefusal, handlePalette, revealRequest } =
    useCanvasHandlers(model, state);

  const showDescribe = mode === "create" && (describeOpen || state.steps.length === 0);
  const inspector = (
    <AutomationEditorInspector
      model={model}
      state={state}
      providers={providers}
      runView={runView}
    />
  );
  const sheetVisible = compact && (state.selection.kind !== "none" || settingsOpen);
  const closeSheet = useCallback(() => {
    setSettingsOpen(false);
    model.select({ kind: "none" });
  }, [model]);
  const sheetHeader = useMemo<SheetHeader>(() => ({ title: inspectorTitle(state, t) }), [state, t]);
  const blockedReason = useBlockedReason(state);
  const direction = compact ? "down" : "right";
  const layout = useMemo(
    () => layoutAutomationGraph({ steps: state.steps, edges: state.edges, direction }),
    [direction, state.edges, state.steps],
  );

  const reveal = useMemo<CanvasReveal | null>(() => {
    const box = revealRequest ? layout.nodes.get(revealRequest.id) : undefined;
    return revealRequest && box
      ? {
          key: revealRequest.key,
          box: { x: box.x, y: box.y, width: NODE_WIDTH, height: NODE_HEIGHT },
        }
      : null;
  }, [layout.nodes, revealRequest]);

  return (
    <>
      <MenuHeader
        title={state.name.trim() || t("automationEditor.newTitle")}
        inPimiTitlebar
        rightContent={headerBackButton}
      />
      <EditorToolbar
        model={model}
        state={state}
        automation={automation}
        compact={compact}
        saving={saving}
        blockedReason={blockedReason}
        showRun={showRun}
        onToggleRun={setShowRun}
        runs={runList.data ?? []}
        shownRunId={runId}
        onPickRun={setRunId}
        onSave={handleSave}
        onApprove={handleApprove}
        onRunNow={handleRunNow}
        onPauseResume={handlePauseResume}
        onDuplicate={handleDuplicate}
        onDelete={handleDelete}
        onDescribe={openDescribe}
        onSettings={openSettings}
        approving={mutations.isApproving}
        runningNow={mutations.isRunningNow}
      />
      {state.dirty ? (
        <UnsavedBar
          canSave={state.canSave}
          saving={saving}
          onSave={handleSave}
          onDiscard={onDiscard}
        />
      ) : null}
      <EditorNotices message={state.submitError ?? actionError ?? linkRefusal} />
      <View style={styles.body}>
        <View style={styles.canvasArea}>
          <Palette onAdd={handlePalette} onInset={setPaletteInset} />
          <AutomationCanvasViewport
            width={layout.width}
            height={layout.height}
            topInset={paletteInset}
            fitKey={direction}
            reveal={reveal}
          >
            <AutomationEditorCanvas
              state={state}
              direction={direction}
              layout={layout}
              nodeText={nodeText}
              runStatuses={runStatuses}
              editable
              onSelect={model.select}
              onAddAfter={handleAddAfter}
              onInsert={handleInsert}
              onDisconnect={model.disconnect}
              onConnect={handleConnect}
            />
          </AutomationCanvasViewport>
          {showDescribe ? (
            <DescribePanel
              state={state}
              onClose={state.steps.length > 0 ? closeDescribe : null}
              onStarted={leaveForList}
            />
          ) : null}
        </View>
        {compact ? null : <View style={styles.inspector}>{inspector}</View>}
      </View>
      {compact ? (
        <AdaptiveModalSheet
          header={sheetHeader}
          visible={sheetVisible}
          onClose={closeSheet}
          snapPoints={["70%", "92%"]}
          testID="automation-inspector-sheet"
        >
          {inspector}
        </AdaptiveModalSheet>
      ) : null}
    </>
  );
}

function useBlockedReason(state: AutomationEditorState): string | null {
  const { t } = useTranslation();
  const firstProblem = state.problems[0];
  return firstProblem
    ? t(`automationEditor.problems.${problemKey(firstProblem)}`, problemParams(firstProblem))
    : null;
}

function UnsavedBar({
  canSave,
  saving,
  onSave,
  onDiscard,
}: {
  canSave: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.unsavedBar} testID="automation-unsaved-bar">
      <Text style={styles.unsavedText} numberOfLines={1}>
        {t("automationEditor.status.unsaved")}
      </Text>
      <View style={styles.unsavedActions}>
        <Button size="sm" variant="ghost" onPress={onDiscard} testID="automation-unsaved-discard">
          {t("automationEditor.actions.discard")}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onPress={onSave}
          loading={saving}
          disabled={!canSave}
          testID="automation-unsaved-save"
        >
          {t("automationEditor.actions.save")}
        </Button>
      </View>
    </View>
  );
}

function EditorNotices({ message }: { message: string | null }): ReactElement | null {
  if (!message) return null;
  return (
    <Text style={styles.errorBar} testID="automation-editor-error">
      {message}
    </Text>
  );
}

function useEditorSnapshot({
  mode,
  serverId,
  templateId,
  stored,
  draftKey,
}: {
  mode: AutomationEditorScreenProps["mode"];
  serverId: string | undefined;
  templateId: string | undefined;
  stored: AggregatedAutomation | null;
  draftKey: string;
}) {
  const { t } = useTranslation();
  const { projects } = useProjects();
  const hostProfiles = useHosts();
  const hosts = useMemo<AutomationEditorHost[]>(
    () => hostProfiles.map((host) => ({ serverId: host.serverId, label: host.label })),
    [hostProfiles],
  );
  const { preferences, updatePreferences } = useFormPreferences();
  const projectTargets = useMemo(() => buildAutomationProjectTargets(projects), [projects]);
  const [initial] = useState(() => {
    const template = AUTOMATION_TEMPLATES.find((candidate) => candidate.id === templateId);
    const source = stored
      ? {
          name:
            mode === "edit" ? stored.name : t("automationEditor.copyName", { name: stored.name }),
          project: stored.project,
          trigger: stored.trigger,
          flow: stored.flow,
          limits: stored.limits,
        }
      : undefined;
    return {
      template,
      source,
      serverId: stored?.serverId ?? serverId ?? null,
      draft: readAutomationEditorDraft(draftKey) ?? undefined,
    };
  });
  const snapshot = useMemo<AutomationEditorSnapshot>(
    () => ({
      mode,
      draft: initial.draft,
      source: initial.source,
      template: initial.template,
      hosts,
      serverId: initial.serverId,
      projectTargets,
      preferences,
      timezone: getDeviceTimeZone(),
      newStepTitles: {
        agent: t("automationEditor.palette.agent"),
        check: t("automationEditor.palette.check"),
      },
    }),
    [hosts, initial, mode, preferences, projectTargets, t],
  );
  return { snapshot, updatePreferences };
}

function useEditorSave({
  model,
  state,
  automation,
  serverId: mutationServerId,
  mutations,
  updatePreferences,
}: {
  model: AutomationEditorModel;
  state: AutomationEditorState;
  automation: AggregatedAutomation | null;
  serverId: string;
  mutations: UseAutomationMutationsResult;
  updatePreferences: ReturnType<typeof useFormPreferences>["updatePreferences"];
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const save = useCallback(async () => {
    if (!state.canSave || saving) return;
    setSaving(true);
    model.setSubmitError(null);
    try {
      const definition = buildAutomationEditorDefinition(state, automation ?? undefined);
      await updatePreferences((current) => updateSelectionPreferences(current, state));
      if (automation) {
        await mutations.updateAutomation({ automationId: automation.id, definition });
        model.markSaved();
        return;
      }
      const created = await mutations.createAutomation({ definition });
      model.markSaved();
      router.replace(buildAutomationEditorRoute(mutationServerId, created.id));
    } catch (error) {
      model.setSubmitError(toErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }, [automation, model, mutationServerId, mutations, router, saving, state, updatePreferences]);
  const handleSave = useCallback(() => void save(), [save]);

  return { saving, handleSave };
}

function useCanvasHandlers(model: AutomationEditorModel, state: AutomationEditorState) {
  const { t } = useTranslation();
  const selectedStepId = state.selection.kind === "step" ? state.selection.id : null;
  // The step just added, so the canvas can pan it into view.
  const [revealRequest, setRevealRequest] = useState<{ key: number; id: string } | null>(null);
  const requestReveal = useCallback((id: string | null) => {
    if (id) setRevealRequest((current) => ({ key: (current?.key ?? 0) + 1, id }));
  }, []);
  const handleAddAfter = useCallback(
    (kind: EditorStep["kind"], from: { nodeId: string; branch?: AutomationEdgeBranch }) => {
      requestReveal(model.addStep(kind, from));
    },
    [model, requestReveal],
  );
  const handleInsert = useCallback(
    (kind: EditorStep["kind"], edge: AutomationEdge) => {
      requestReveal(model.insertStep(kind, edge));
    },
    [model, requestReveal],
  );
  const [linkRefusal, setLinkRefusal] = useState<string | null>(null);
  const handleConnect = useCallback(
    (from: string, to: string, branch: AutomationEdgeBranch | undefined) => {
      const refused = model.connect(from, to, branch);
      setLinkRefusal(refused ? t(`automationEditor.linkRefused.${refused}`) : null);
    },
    [model, t],
  );
  const deleteSelected = useMemo(
    () => (selectedStepId ? () => model.removeStep(selectedStepId) : null),
    [model, selectedStepId],
  );
  useDeleteSelectedStep(deleteSelected);
  const handlePalette = useCallback(
    (kind: EditorStep["kind"]) => {
      const selected = state.steps.find((step) => step.id === selectedStepId);
      requestReveal(
        model.addStep(
          kind,
          selected
            ? {
                nodeId: selected.id,
                ...(selected.kind === "condition" ? { branch: "true" as const } : {}),
              }
            : { nodeId: TRIGGER_NODE_ID },
        ),
      );
    },
    [model, requestReveal, selectedStepId, state.steps],
  );

  return { handleAddAfter, handleInsert, handleConnect, linkRefusal, handlePalette, revealRequest };
}

function useEditorRuns({
  serverId,
  automation,
  retryAutomationRun,
  retrying,
}: {
  serverId: string;
  automation: AggregatedAutomation | null;
  retryAutomationRun: UseAutomationMutationsResult["retryAutomationRun"];
  retrying: boolean;
}) {
  const [runId, setRunId] = useState(automation?.lastRun?.id);
  const [showRun, setShowRun] = useState(false);
  const runList = useRunList(serverId, automation?.id);
  const run = useShownRun({ serverId, automationId: automation?.id, runId });
  useEffect(() => {
    if (!runId && automation?.lastRun?.id) setRunId(automation.lastRun.id);
  }, [automation?.lastRun?.id, runId]);
  const showStartedRun = useCallback(
    (started: AutomationRun) => {
      setRunId(started.id);
      setShowRun(true);
      void runList.refetch();
    },
    [runList],
  );
  const [retryError, setRetryError] = useState<string | null>(null);
  const handleRetry = useCallback(async () => {
    if (!automation || !run) return;
    setRetryError(null);
    try {
      showStartedRun(await retryAutomationRun({ automationId: automation.id, runId: run.id }));
    } catch (error) {
      setRetryError(toErrorMessage(error));
    }
  }, [automation, retryAutomationRun, run, showStartedRun]);
  const runView = useMemo<InspectorRunView | null>(() => {
    if (!showRun || !run) return null;
    const retryable =
      (run.status === "failed" || run.status === "cancelled") && automation?.status === "active";
    return {
      run,
      onRetry: retryable ? () => void handleRetry() : null,
      retrying,
      retryError,
    };
  }, [automation?.status, handleRetry, retrying, retryError, run, showRun]);
  const runStatuses = useMemo<ReadonlyMap<string, AutomationRunStepStatus> | null>(
    () => (runView ? new Map(runView.run.steps.map((step) => [step.nodeId, step.status])) : null),
    [runView],
  );
  return { runId, setRunId, showRun, setShowRun, runList, runView, runStatuses, showStartedRun };
}

function useEditorActions({
  automation,
  mutations,
  draftKey,
  onRunStarted,
}: {
  automation: AggregatedAutomation | null;
  mutations: UseAutomationMutationsResult;
  draftKey: string;
  onRunStarted: (run: AutomationRun) => void;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const [actionError, setActionError] = useState<string | null>(null);
  const runAction = useCallback(async (action: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(toErrorMessage(error));
    }
  }, []);
  const handleApprove = useCallback(() => {
    if (automation) void runAction(() => mutations.approveAutomation(automation.id));
  }, [automation, mutations, runAction]);
  const handleRunNow = useCallback(() => {
    if (!automation) return;
    void runAction(async () => onRunStarted(await mutations.runAutomationNow(automation.id)));
  }, [automation, mutations, onRunStarted, runAction]);
  const handlePauseResume = useCallback(() => {
    if (!automation) return;
    void runAction(() =>
      automation.status === "paused"
        ? mutations.resumeAutomation(automation.id)
        : mutations.pauseAutomation(automation.id),
    );
  }, [automation, mutations, runAction]);
  const handleDuplicate = useCallback(() => {
    if (!automation) return;
    router.push(
      buildNewAutomationRoute({ serverId: automation.serverId, duplicateId: automation.id }),
    );
  }, [automation, router]);
  const handleDelete = useCallback(() => {
    if (!automation) return;
    void (async () => {
      const confirmed = await confirmDialog({
        title: t("automationEditor.confirm.deleteTitle"),
        message: t("automationEditor.confirm.deleteMessage", { name: automation.name }),
        confirmLabel: t("automationEditor.confirm.delete"),
        destructive: true,
      });
      if (!confirmed) return;
      await runAction(async () => {
        await mutations.deleteAutomation(automation.id);
        clearAutomationEditorDraft(draftKey);
        router.replace(buildAutomationsRoute());
      });
    })();
  }, [automation, draftKey, mutations, router, runAction, t]);
  return {
    actionError,
    handleApprove,
    handleRunNow,
    handlePauseResume,
    handleDuplicate,
    handleDelete,
  };
}

function inspectorTitle(state: AutomationEditorState, t: (key: string) => string): string {
  if (state.selection.kind === "trigger") return t("automationEditor.inspector.triggerTitle");
  if (state.selection.kind === "step") {
    const id = state.selection.id;
    const step = state.steps.find((candidate) => candidate.id === id);
    return step?.kind === "condition"
      ? t("automationEditor.inspector.checkTitle")
      : t("automationEditor.inspector.stepTitle");
  }
  return t("automationEditor.inspector.settingsTitle");
}

function useNodeText(state: AutomationEditorState): ReadonlyMap<string, CanvasNodeText> {
  const { t } = useTranslation();
  return useMemo(() => {
    const map = new Map<string, CanvasNodeText>();
    let trigger: string;
    switch (state.triggerKind) {
      case "cron":
        trigger = t("automationEditor.triggerSummary.cron", { expression: state.cron.expression });
        break;
      case "interval": {
        const parts = everyMsToParts(state.intervalMs);
        trigger = t("automationEditor.triggerSummary.interval", {
          value: parts.value,
          unit: t(`automationEditor.units.${parts.unit}`),
        });
        break;
      }
      case "pull_request":
        trigger = state.prRepo.trim()
          ? t("automationEditor.triggerSummary.pullRequest", { repo: state.prRepo.trim() })
          : t("automationEditor.triggerKinds.pull_request");
        break;
      default:
        trigger = t("automationEditor.triggerKinds.manual");
    }
    map.set(TRIGGER_NODE_ID, { title: t("automationEditor.nodes.trigger"), subtitle: trigger });
    for (const step of state.steps) {
      if (step.kind === "condition") {
        const needsValue = step.operator !== "is_empty" && step.operator !== "not_empty";
        map.set(step.id, {
          title: step.title || step.id,
          subtitle: `${t(`automationEditor.operators.${step.operator}`)}${needsValue && step.value ? ` "${step.value}"` : ""}`,
        });
        continue;
      }
      const effective = effectiveStepModel(step, state.defaults);
      const label = effective.provider
        ? modelLabel(state.providerEntries, effective.provider, effective.model) ||
          effective.provider
        : t("automationEditor.nodes.noModel");
      map.set(step.id, { title: step.title || step.id, subtitle: label });
    }
    return map;
  }, [
    state.cron.expression,
    state.defaults,
    state.intervalMs,
    state.prRepo,
    state.providerEntries,
    state.steps,
    state.triggerKind,
    t,
  ]);
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

// Module-scope themed icons so menu `leading` props are stable elements.
const menuIconProps = (theme: Theme) => ({ size: 14, color: theme.colors.foregroundMuted });
const ThemedSettings = withUnistyles(Settings2);
const ThemedSparkles = withUnistyles(Sparkles);
const ThemedPlay = withUnistyles(Play);
const ThemedPause = withUnistyles(Pause);
const ThemedCopy = withUnistyles(Copy);
const ThemedTrash = withUnistyles(Trash2);
const settingsMenuIcon = <ThemedSettings uniProps={menuIconProps} />;
const describeMenuIcon = (
  <ThemedSparkles uniProps={(theme: Theme) => ({ size: 14, color: theme.colors.accent })} />
);
const resumeMenuIcon = <ThemedPlay uniProps={menuIconProps} />;
const pauseMenuIcon = <ThemedPause uniProps={menuIconProps} />;
const duplicateMenuIcon = <ThemedCopy uniProps={menuIconProps} />;
const deleteMenuIcon = <ThemedTrash uniProps={menuIconProps} />;
const headerBackButton = <BackButton />;

const STATUS_VARIANT: Record<Automation["status"], "success" | "warning" | "error" | "muted"> = {
  pending: "warning",
  active: "success",
  paused: "muted",
  ended: "muted",
};

function EditorToolbar(props: {
  model: AutomationEditorModel;
  state: AutomationEditorState;
  automation: AggregatedAutomation | null;
  compact: boolean;
  saving: boolean;
  blockedReason: string | null;
  showRun: boolean;
  onToggleRun: (value: boolean) => void;
  runs: AutomationRun[];
  shownRunId: string | undefined;
  onPickRun: (runId: string) => void;
  onSave: () => void;
  onApprove: () => void;
  onRunNow: () => void;
  onPauseResume: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onDescribe: () => void;
  onSettings: () => void;
  approving: boolean;
  runningNow: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const { model, state, automation, compact } = props;
  const statusKey = automation?.status ?? "new";
  const statusLabel = t(`automationEditor.status.${statusKey}`);
  return (
    <View style={styles.toolbar}>
      <View style={styles.toolbarStart}>
        <NameInput model={model} name={state.name} />
        <StatusBadge
          label={statusLabel}
          variant={automation ? STATUS_VARIANT[automation.status] : "muted"}
        />
      </View>
      <View style={styles.toolbarEnd}>
        {automation ? (
          <RunControls
            automation={automation}
            compact={compact}
            dirty={state.dirty}
            showRun={props.showRun}
            onToggleRun={props.onToggleRun}
            runs={props.runs}
            shownRunId={props.shownRunId}
            onPickRun={props.onPickRun}
            onApprove={props.onApprove}
            onRunNow={props.onRunNow}
            approving={props.approving}
            runningNow={props.runningNow}
          />
        ) : null}
        {props.blockedReason && !compact ? (
          <Text style={styles.blocked} numberOfLines={1} testID="automation-save-blocked">
            {t("automationEditor.saveBlocked", { reason: props.blockedReason })}
          </Text>
        ) : null}
        <Button
          size="sm"
          variant="default"
          onPress={props.onSave}
          loading={props.saving}
          disabled={!state.canSave}
          accessibilityHint={props.blockedReason ?? undefined}
          testID="automation-save"
        >
          {automation ? t("automationEditor.actions.save") : t("automationEditor.actions.create")}
        </Button>
        <OverflowMenu {...props} />
      </View>
      {props.blockedReason && compact ? (
        <Text style={styles.blockedCompact} numberOfLines={2} testID="automation-save-blocked">
          {t("automationEditor.saveBlocked", { reason: props.blockedReason })}
        </Text>
      ) : null}
    </View>
  );
}

function RunControls(props: {
  automation: AggregatedAutomation;
  compact: boolean;
  dirty: boolean;
  showRun: boolean;
  onToggleRun: (value: boolean) => void;
  runs: AutomationRun[];
  shownRunId: string | undefined;
  onPickRun: (runId: string) => void;
  onApprove: () => void;
  onRunNow: () => void;
  approving: boolean;
  runningNow: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const { automation, compact } = props;
  const canRunNow = automation.status === "active" && !props.dirty;
  const { onToggleRun, showRun } = props;
  const toggleRun = useCallback(() => onToggleRun(!showRun), [onToggleRun, showRun]);
  const toggleState = useMemo(() => ({ selected: showRun }), [showRun]);
  return (
    <>
      <Button
        size="sm"
        variant={props.showRun ? "secondary" : "ghost"}
        leftIcon={History}
        onPress={toggleRun}
        disabled={props.runs.length === 0}
        accessibilityState={toggleState}
        testID="automation-toggle-last-run"
      >
        {compact ? undefined : t("automationEditor.runs.lastRun")}
      </Button>
      {props.showRun && props.runs.length > 1 ? (
        <RunPicker runs={props.runs} shownRunId={props.shownRunId} onPick={props.onPickRun} />
      ) : null}
      {automation.status === "pending" ? (
        <Button
          size="sm"
          variant="outline"
          onPress={props.onApprove}
          loading={props.approving}
          disabled={props.dirty}
          testID="automation-approve"
        >
          {t("automationEditor.actions.approve")}
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="outline"
        leftIcon={Play}
        onPress={props.onRunNow}
        loading={props.runningNow}
        disabled={!canRunNow}
        testID="automation-run-now"
      >
        {compact ? undefined : t("automationEditor.actions.runNow")}
      </Button>
    </>
  );
}

function NameInput({ model, name }: { model: AutomationEditorModel; name: string }): ReactElement {
  const { t } = useTranslation();
  const [initialName] = useState(name);
  const handleChange = useCallback((next: string) => model.setName(next), [model]);
  return (
    <EditingTextInput
      initialValue={initialName}
      onChangeText={handleChange}
      placeholder={t("automationEditor.namePlaceholder")}
      placeholderTextColor={styles.placeholder.color}
      accessibilityLabel={t("automationEditor.nameLabel")}
      style={styles.nameInput}
      testID="automation-name-input"
    />
  );
}

function RunPicker({
  runs,
  shownRunId,
  onPick,
}: {
  runs: AutomationRun[];
  shownRunId: string | undefined;
  onPick: (runId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const shown = runs.find((candidate) => candidate.id === shownRunId) ?? runs[0];
  return (
    <DropdownMenu>
      <DropdownTrigger
        size="sm"
        accessibilityLabel={t("automationEditor.runs.pickRun")}
        testID="automation-run-picker"
      >
        {shown ? runLabel(shown, t) : t("automationEditor.runs.pickRun")}
      </DropdownTrigger>
      <DropdownMenuContent align="end" width={280} sheetTitle={t("automationEditor.runs.pickRun")}>
        {runs.map((candidate) => (
          <RunItem
            key={candidate.id}
            run={candidate}
            selected={candidate.id === shown?.id}
            label={runLabel(candidate, t)}
            onPick={onPick}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function runLabel(
  run: AutomationRun,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  return t("automationEditor.runs.runLabel", {
    when: new Date(run.startedAt).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }),
    status: t(`automationEditor.runs.status.${run.status}`),
  });
}

function RunItem({
  run,
  selected,
  label,
  onPick,
}: {
  run: AutomationRun;
  selected: boolean;
  label: string;
  onPick: (runId: string) => void;
}): ReactElement {
  const handleSelect = useCallback(() => onPick(run.id), [onPick, run.id]);
  return (
    <DropdownMenuItem
      selected={selected}
      showSelectedCheck
      onSelect={handleSelect}
      testID={`automation-run-${run.id}`}
    >
      {label}
    </DropdownMenuItem>
  );
}

function OverflowMenu(props: {
  automation: AggregatedAutomation | null;
  compact: boolean;
  onPauseResume: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onDescribe: () => void;
  onSettings: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const { automation } = props;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        style={styles.overflowTrigger}
        accessibilityRole="button"
        accessibilityLabel={t("automationEditor.actions.more")}
        testID="automation-more"
      >
        <MoreHorizontal size={18} color={styles.menuIcon.color} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={240} sheetTitle={t("automationEditor.actions.more")}>
        {props.compact ? (
          <DropdownMenuItem
            leading={settingsMenuIcon}
            onSelect={props.onSettings}
            testID="automation-open-settings"
          >
            {t("automationEditor.actions.settings")}
          </DropdownMenuItem>
        ) : null}
        {automation ? null : (
          <DropdownMenuItem
            leading={describeMenuIcon}
            onSelect={props.onDescribe}
            testID="automation-describe"
          >
            {t("automationEditor.actions.describe")}
          </DropdownMenuItem>
        )}
        {automation && (automation.status === "active" || automation.status === "paused") ? (
          <DropdownMenuItem
            leading={automation.status === "paused" ? resumeMenuIcon : pauseMenuIcon}
            onSelect={props.onPauseResume}
            testID="automation-pause-resume"
          >
            {automation.status === "paused"
              ? t("automationEditor.actions.resume")
              : t("automationEditor.actions.pause")}
          </DropdownMenuItem>
        ) : null}
        {automation ? (
          <DropdownMenuItem
            leading={duplicateMenuIcon}
            onSelect={props.onDuplicate}
            testID="automation-duplicate"
          >
            {t("automationEditor.actions.duplicate")}
          </DropdownMenuItem>
        ) : null}
        {automation ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              destructive
              leading={deleteMenuIcon}
              onSelect={props.onDelete}
              testID="automation-delete"
            >
              {t("automationEditor.actions.delete")}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// Canvas overlays
// ---------------------------------------------------------------------------

function Palette({
  onAdd,
  onInset,
}: {
  onAdd: (kind: EditorStep["kind"]) => void;
  /** Reports how far down the palette's bottom edge reaches. */
  onInset: (inset: number) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleLayout = useCallback(
    ({ nativeEvent }: LayoutChangeEvent) =>
      onInset(nativeEvent.layout.y + nativeEvent.layout.height),
    [onInset],
  );
  const addAgent = useCallback(() => onAdd("agent"), [onAdd]);
  const addCheck = useCallback(() => onAdd("condition"), [onAdd]);
  return (
    <View style={styles.palette} onLayout={handleLayout} testID="automation-palette">
      <Text style={styles.paletteTitle}>{t("automationEditor.palette.title")}</Text>
      <Button
        size="sm"
        variant="ghost"
        leftIcon={Bot}
        onPress={addAgent}
        testID="automation-palette-agent"
      >
        {t("automationEditor.palette.agent")}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        leftIcon={Split}
        onPress={addCheck}
        testID="automation-palette-check"
      >
        {t("automationEditor.palette.check")}
      </Button>
    </View>
  );
}

function DescribePanel({
  state,
  onClose,
  onStarted,
}: {
  state: AutomationEditorState;
  onClose: (() => void) | null;
  onStarted: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const drafts = useAutomationDraftActions();
  const [description, setDescription] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cwd = state.workingDir.trim();
  const serverId = state.selectedServerId;
  const canStart = Boolean(cwd && serverId && description.trim()) && !starting;
  const handleStart = useCallback(async () => {
    if (!canStart || !serverId) return;
    // The canvas keeps its unsaved graph as a draft, so describing leaves nothing behind.
    setError(null);
    setStarting(true);
    try {
      await drafts.start({ serverId, description: description.trim(), cwd });
      onStarted();
    } catch (startError) {
      setError(toErrorMessage(startError));
      setStarting(false);
    }
  }, [canStart, cwd, description, drafts, onStarted, serverId]);
  const handlePress = useCallback(() => void handleStart(), [handleStart]);
  return (
    <View style={styles.describe} testID="automation-describe-panel">
      <View style={styles.describeHeader}>
        <Sparkles size={16} color={styles.menuIcon.color} />
        <Text style={styles.describeTitle}>{t("automationEditor.describe.title")}</Text>
        {onClose ? (
          <Button
            size="sm"
            variant="ghost"
            leftIcon={X}
            onPress={onClose}
            accessibilityLabel={t("automationEditor.describe.close")}
            testID="automation-describe-close"
          />
        ) : null}
      </View>
      <FormTextInput
        size="md"
        testID="automation-describe-input"
        accessibilityLabel={t("automationEditor.describe.title")}
        initialValue=""
        onChangeText={setDescription}
        placeholder={t("automationEditor.describe.placeholder")}
        style={styles.describeInput}
        multiline
        numberOfLines={3}
        textAlignVertical="top"
      />
      {cwd ? (
        <Text style={styles.muted}>{t("automationEditor.describe.background")}</Text>
      ) : (
        <Text style={styles.muted}>{t("automationEditor.describe.needsProject")}</Text>
      )}
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      <View style={styles.describeActions}>
        <Text style={styles.muted}>{t("automationEditor.describe.or")}</Text>
        <Button
          size="sm"
          variant="default"
          leftIcon={Sparkles}
          onPress={handlePress}
          loading={starting}
          disabled={!canStart}
          testID="automation-describe-compile"
        >
          {t("automationEditor.describe.compile")}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  toolbar: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  toolbarStart: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 1,
    minWidth: 160,
  },
  toolbarEnd: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 1,
  },
  nameInput: {
    flexShrink: 1,
    minWidth: 120,
    maxWidth: 360,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: "600",
    fontFamily: theme.fontFamily.ui,
  },
  placeholder: {
    color: theme.colors.foregroundMuted,
  },
  unsavedBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  unsavedText: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  unsavedActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  blocked: {
    flexShrink: 1,
    maxWidth: 280,
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
  blockedCompact: {
    width: "100%",
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
  overflowTrigger: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  menuIcon: {
    color: theme.colors.foregroundMuted,
  },
  errorBar: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
  errorText: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
  body: {
    flex: 1,
    flexDirection: "row",
    minHeight: 0,
  },
  canvasArea: {
    flex: 1,
    minWidth: 0,
    position: "relative",
  },
  inspector: {
    width: INSPECTOR_WIDTH,
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  // The palette floats over the canvas; the viewport fits the graph below it.
  palette: {
    position: "absolute",
    top: theme.spacing[3],
    left: theme.spacing[3],
    zIndex: 2,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    padding: theme.spacing[1],
    paddingLeft: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  paletteTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  describe: {
    position: "absolute",
    left: theme.spacing[4],
    right: theme.spacing[4],
    bottom: 64,
    alignSelf: "center",
    maxWidth: 640,
    marginHorizontal: "auto",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.xl,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  describeHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  describeTitle: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: "600",
  },
  describeInput: {
    minHeight: 72,
  },
  describeActions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
}));
