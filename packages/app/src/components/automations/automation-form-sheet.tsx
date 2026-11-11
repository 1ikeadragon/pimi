import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Brain, Folder, GitBranch } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { useFetchQuery } from "@/data/query";
import type { AgentProvider } from "@pimi/protocol/agent-types";
import type {
  Automation,
  AutomationConditionOperator,
  AutomationDefinition,
  AutomationEdge,
  AutomationEdgeBranch,
  AutomationRun,
  PullRequestEvent,
} from "@pimi/protocol/automation/types";
import { stepOutputReference, upstreamNodeIds } from "@pimi/protocol/automation/validate";
import {
  AutomationFlowCanvas,
  type AutomationCanvasStep,
} from "@/components/automations/automation-flow-canvas";
import { useSessionStore } from "@/stores/session-store";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { ComboboxItem } from "@/components/ui/combobox";
import { Button } from "@/components/ui/button";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import { HostStatusDotSlot } from "@/components/hosts/host-picker";
import { type ControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useProviderIcon } from "@/components/provider-icons";
import { CadenceEditor } from "@/components/automations/cadence-editor";
import {
  SelectField,
  SelectFieldTrigger,
  type SelectFieldDisplay,
  type SelectFieldOption,
  type SelectFieldRenderOptionInput,
} from "@/components/ui/select-field";
import { formatThinkingOptionLabel } from "@/agent-controls/labels";
import { useAgentProfiles } from "@/agent-profiles";
import {
  mergeProviderPreferences,
  useFormPreferences,
  type FormPreferences,
} from "@/hooks/use-form-preferences";
import { useAutomationMutations } from "@/hooks/use-automation-mutations";
import { useProjects } from "@/hooks/use-projects";
import { useHosts } from "@/runtime/host-runtime";
import { buildAutomationProjectTargets } from "@/automations/automation-project-targets";
import type { AutomationTemplate } from "@/automations/automation-templates";
import { useAutomationFormModel } from "@/automations/use-automation-form-model";
import { useAutomationFormProviderSnapshot } from "@/automations/use-automation-form-provider-snapshot";
import type {
  AutomationFormConditionStep,
  AutomationFormDisplay,
  AutomationFormHost,
  AutomationFormModel,
  AutomationFormSnapshot,
  AutomationFormState,
  AutomationFormTriggerKind,
} from "@/automations/automation-form-model";
import {
  buildAutomationFormFlow,
  buildAutomationFormTrigger,
  UNATTENDED_MODE_LABEL,
} from "@/automations/automation-form-model";
import { validateCron } from "@/utils/automation-format";
import { toErrorMessage } from "@/utils/error-messages";
import { getDeviceTimeZone } from "@/utils/device-timezone";

export interface AutomationFormSheetProps {
  serverId?: string;
  visible: boolean;
  onClose: () => void;
  mode: "create" | "edit";
  automation?: Automation;
  template?: AutomationTemplate;
  /** A definition compiled from prose. Saving it creates a pending automation. */
  draft?: AutomationDefinition;
}

function parseMaxRuns(raw: string): number | null {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// On edit, the stored description and limits other than max runs are kept.
function buildDefinition(input: {
  state: AutomationFormState;
  automation: Automation | undefined;
  draft: AutomationDefinition | undefined;
  cwd: string;
}): AutomationDefinition {
  const { state, automation } = input;
  const stored = automation ?? input.draft;
  return {
    name: state.name.trim(),
    description: stored?.description ?? null,
    project: { cwd: input.cwd },
    trigger: buildAutomationFormTrigger(state, stored?.trigger),
    flow: buildAutomationFormFlow(
      state,
      state.submitIsolation === "worktree" ? "worktree" : "project",
    ),
    limits: { ...automation?.limits, maxRuns: parseMaxRuns(state.maxRuns) },
  };
}

const TRIGGER_LABELS: Record<AutomationFormTriggerKind, string> = {
  schedule: "On a schedule",
  pull_request: "On pull requests",
  manual: "Run by hand",
};

const TRIGGER_OPTIONS: SelectFieldOption<AutomationFormTriggerKind>[] = (
  ["schedule", "pull_request", "manual"] as const
).map((kind) => ({
  id: kind,
  value: kind,
  label: TRIGGER_LABELS[kind],
  testID: `automation-trigger-${kind}`,
}));

function sheetTitle(mode: "create" | "edit", isDraft: boolean): string {
  if (mode === "edit") {
    return "Edit automation";
  }
  return isDraft ? "Review automation" : "New automation";
}

function resolveCreateServerId(input: {
  mode: "create" | "edit";
  serverId: string | null | undefined;
  hosts: readonly AutomationFormHost[];
}): string | null {
  if (input.mode === "edit") {
    return input.serverId ?? null;
  }
  if (input.serverId !== undefined) {
    return input.serverId;
  }
  if (input.hosts.length === 1) {
    return input.hosts[0]?.serverId ?? null;
  }
  return null;
}

function buildAutomationHostOptionTestId(serverId: string): string {
  return `automation-host-option-${serverId}`;
}

function buildThinkingOptionTestId(optionId: string): string {
  return `automation-thinking-option-${optionId}`;
}

function openKey(props: AutomationFormSheetProps): string {
  if (props.mode === "edit") {
    return `edit:${props.serverId ?? ""}:${props.automation?.id ?? ""}`;
  }
  return `create:${props.serverId ?? ""}:${props.template?.id ?? ""}:${props.draft ? "draft" : ""}`;
}

function buildSnapshot(input: {
  mode: "create" | "edit";
  serverId: string | undefined;
  automation: Automation | undefined;
  hosts: readonly AutomationFormHost[];
  projectTargets: ReturnType<typeof buildAutomationProjectTargets>;
  preferences: FormPreferences;
  timezone: string;
  template?: AutomationTemplate;
  draft?: AutomationDefinition;
}): AutomationFormSnapshot {
  const automation = input.automation
    ? { ...input.automation, serverId: input.serverId, serverName: undefined }
    : undefined;
  return {
    mode: input.mode,
    automation,
    hosts: input.hosts,
    defaults: {
      serverId: resolveCreateServerId({
        mode: input.mode,
        serverId: input.serverId,
        hosts: input.hosts,
      }),
      projectTargets: input.projectTargets,
      preferences: input.preferences,
      timezone: input.timezone,
      template: input.template,
      draft: input.draft,
    },
  };
}

function updateSelectionPreferences(input: {
  preferences: FormPreferences;
  provider: AgentProvider;
  model: string;
  mode: string;
  thinkingOptionId: string;
  isolation: "local" | "worktree";
}): FormPreferences {
  const model = input.model.trim();
  const mode = input.mode.trim();
  const thinkingOptionId = input.thinkingOptionId.trim();
  return {
    ...mergeProviderPreferences({
      preferences: input.preferences,
      provider: input.provider,
      updates: {
        model: model || undefined,
        mode: mode || undefined,
        ...(model && thinkingOptionId ? { thinkingByModel: { [model]: thinkingOptionId } } : {}),
      },
    }),
    isolation: input.isolation,
  };
}

export function AutomationFormSheet(props: AutomationFormSheetProps): ReactElement | null {
  const [renderedProps, setRenderedProps] = useState<AutomationFormSheetProps | null>(() =>
    props.visible ? props : null,
  );
  const [sheetVisible, setSheetVisible] = useState(props.visible);
  const livePropsRef = useRef(props);
  const closeRequestedRef = useRef(false);
  livePropsRef.current = props;

  useEffect(() => {
    if (props.visible) {
      if (closeRequestedRef.current) {
        return;
      }
      setRenderedProps(props);
      setSheetVisible(true);
      return;
    }
    if (renderedProps) {
      setSheetVisible(false);
    }
  }, [props, renderedProps]);

  const requestClose = useCallback(() => {
    closeRequestedRef.current = true;
    setSheetVisible(false);
  }, []);

  const handleDismiss = useCallback(() => {
    const dismissedProps = livePropsRef.current;
    closeRequestedRef.current = false;
    setRenderedProps(null);
    setSheetVisible(false);
    if (dismissedProps.visible) {
      dismissedProps.onClose();
    }
  }, []);

  if (!renderedProps) {
    return null;
  }

  return (
    <OpenAutomationFormSheet
      key={openKey(renderedProps)}
      {...renderedProps}
      visible={sheetVisible}
      onClose={requestClose}
      onDismiss={handleDismiss}
    />
  );
}

function OpenAutomationFormSheet({
  serverId,
  visible,
  onClose,
  onDismiss,
  mode,
  automation,
  template,
  draft,
}: AutomationFormSheetProps & { onDismiss: () => void }): ReactElement {
  const controlSize: ControlSize = "md";
  const { projects } = useProjects();
  const hostProfiles = useHosts();
  const hosts = useMemo<AutomationFormHost[]>(
    () => hostProfiles.map((host) => ({ serverId: host.serverId, label: host.label })),
    [hostProfiles],
  );
  const { preferences, updatePreferences } = useFormPreferences();
  const projectTargets = useMemo(() => buildAutomationProjectTargets(projects), [projects]);
  const timezone = useMemo(getDeviceTimeZone, []);
  const snapshot = useMemo(
    () =>
      buildSnapshot({
        mode,
        serverId,
        automation,
        hosts,
        projectTargets,
        preferences,
        timezone,
        template,
        draft,
      }),
    [hosts, mode, preferences, projectTargets, automation, serverId, timezone, template, draft],
  );
  const model = useAutomationFormModel(snapshot);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const providerSnapshot = useAutomationFormProviderSnapshot(model, state);
  const mutationServerId = state.selectedServerId ?? serverId ?? "";
  const { createAutomation, updateAutomation, isCreating, isUpdating } = useAutomationMutations({
    serverId: mutationServerId,
  });

  const isSubmitting = isCreating || isUpdating;
  const cadenceError =
    state.triggerKind === "schedule" && state.cadence.type === "cron"
      ? validateCron(state.cadence.expression)
      : null;
  const canSubmit = state.canSubmit && cadenceError === null && !isSubmitting;
  const persistPreferences = useCallback(async () => {
    const provider = state.selectedProvider;
    if (!provider) {
      return;
    }
    await updatePreferences((current) =>
      updateSelectionPreferences({
        preferences: current,
        provider,
        model: state.selectedModel,
        mode: state.selectedMode,
        thinkingOptionId: state.selectedThinkingOptionId,
        isolation: state.isolation,
      }),
    );
  }, [
    state.isolation,
    state.selectedMode,
    state.selectedModel,
    state.selectedProvider,
    state.selectedThinkingOptionId,
    updatePreferences,
  ]);

  const submit = useCallback(async (): Promise<boolean> => {
    const cwd = state.workingDir.trim();
    if (!cwd) {
      return false;
    }
    const definition = buildDefinition({ state, automation, draft, cwd });
    await persistPreferences();
    if (mode === "edit" && automation) {
      await updateAutomation({ automationId: automation.id, definition });
      return true;
    }
    await createAutomation({ definition, ...(draft ? { origin: { kind: "compiled" } } : {}) });
    return true;
  }, [createAutomation, draft, mode, persistPreferences, automation, state, updateAutomation]);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) {
      return;
    }
    model.setSubmitError(null);
    try {
      if (await submit()) {
        onClose();
      }
    } catch (error) {
      model.setSubmitError(toErrorMessage(error));
    }
  }, [canSubmit, model, onClose, submit]);

  const handleSubmitPress = useCallback(() => {
    void handleSubmit();
  }, [handleSubmit]);

  const header = useMemo<SheetHeader>(
    () => ({ title: sheetTitle(mode, Boolean(draft)) }),
    [draft, mode],
  );

  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button
          style={styles.footerButton}
          variant="secondary"
          onPress={onClose}
          disabled={isSubmitting}
        >
          Cancel
        </Button>
        <Button
          style={styles.footerButton}
          variant="default"
          onPress={handleSubmitPress}
          disabled={!canSubmit}
          loading={isSubmitting}
          testID="automation-form-submit"
        >
          {mode === "edit" ? "Save changes" : "Create automation"}
        </Button>
      </View>
    ),
    [canSubmit, handleSubmitPress, isSubmitting, mode, onClose],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      onDismiss={onDismiss}
      footer={footer}
      testID="automation-form-sheet"
    >
      {draft ? (
        <Text style={styles.draftNotice}>
          Compiled from your description. Check each step before saving; it waits for your approval
          before it runs.
        </Text>
      ) : null}
      <AutomationFormFields
        model={model}
        state={state}
        providerSnapshot={providerSnapshot}
        controlSize={controlSize}
        cadenceError={cadenceError}
        mutationServerId={mutationServerId}
        automation={mode === "edit" ? automation : undefined}
      />
    </AdaptiveModalSheet>
  );
}

interface AutomationFormFieldsProps {
  model: AutomationFormModel;
  state: AutomationFormState;
  providerSnapshot: ReturnType<typeof useAutomationFormProviderSnapshot>;
  controlSize: ControlSize;
  cadenceError: string | null;
  mutationServerId: string;
  automation: Automation | undefined;
}

function AutomationFormFields({
  model,
  state,
  providerSnapshot,
  controlSize,
  cadenceError,
  mutationServerId,
  automation,
}: AutomationFormFieldsProps): ReactElement {
  const triggerDisplay = useMemo<SelectFieldDisplay>(
    () => ({ label: TRIGGER_LABELS[state.triggerKind] }),
    [state.triggerKind],
  );
  const selectedStep = state.steps.find((step) => step.id === state.selectedStepId) ?? null;
  const [link, setLink] = useState<StepLink | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const handlePressStep = useCallback(
    (stepId: string) => {
      if (link && link.from !== stepId) {
        setLinkError(model.connectSteps(link.from, stepId, link.branch));
        setLink(null);
        return;
      }
      setLink(null);
      setLinkError(null);
      model.selectStep(stepId);
    },
    [link, model],
  );
  const handleStartLink = useCallback((next: StepLink | null) => {
    setLinkError(null);
    setLink(next);
  }, []);
  return (
    <>
      <Field label="Name">
        <FormTextInput
          size={controlSize}
          testID="automation-name-input"
          accessibilityLabel="Automation name"
          initialValue={state.name}
          onChangeText={model.setName}
          placeholder="Weekday PR review"
          autoCapitalize="sentences"
          autoCorrect={false}
        />
      </Field>

      <SelectField
        label="Trigger"
        value={state.triggerKind}
        selectedDisplay={triggerDisplay}
        options={TRIGGER_OPTIONS}
        onChange={model.setTriggerKind}
        placeholder="Select trigger"
        emptyText="No triggers found"
        searchable={false}
        title="Trigger"
        size={controlSize}
        triggerTestID="automation-trigger-trigger"
      />

      {state.triggerKind === "schedule" ? (
        <CadenceEditor
          value={state.cadence}
          onChange={model.setCadence}
          error={cadenceError ?? undefined}
          size={controlSize}
        />
      ) : null}

      {state.triggerKind === "pull_request" ? (
        <PullRequestTriggerFields model={model} state={state} size={controlSize} />
      ) : null}

      <AutomationTargetFields
        section="automation"
        model={model}
        state={state}
        providerSnapshot={providerSnapshot}
        controlSize={controlSize}
        mutationServerId={mutationServerId}
      />

      <AutomationStepsSection
        state={state}
        automation={automation}
        serverId={mutationServerId}
        linkFromStepId={link?.from ?? null}
        onPressStep={handlePressStep}
      />

      {state.steps.length > 1 ? (
        <Field label="Step name">
          <FormTextInput
            key={state.selectedStepId}
            size={controlSize}
            testID="automation-step-title-input"
            accessibilityLabel="Step name"
            initialValue={selectedStep?.title ?? ""}
            onChangeText={model.setStepTitle}
            placeholder="Review"
            autoCorrect={false}
          />
        </Field>
      ) : null}

      {selectedStep?.kind === "condition" ? (
        <ConditionStepFields
          key={selectedStep.id}
          model={model}
          step={selectedStep}
          size={controlSize}
        />
      ) : (
        <>
          <Field label="Prompt" hint={promptHint(state)}>
            <FormTextInput
              key={state.agentStepId}
              size={controlSize}
              testID="automation-prompt-input"
              accessibilityLabel="Prompt"
              initialValue={state.prompt}
              onChangeText={model.setPrompt}
              placeholder="What should the agent do each run?"
              style={styles.multilineInput}
              multiline
              numberOfLines={4}
              textAlignVertical="top"
            />
          </Field>

          <AutomationProfileField
            serverId={state.selectedServerId}
            value={state.selectedProfileId}
            onChange={model.setProfile}
            size={controlSize}
          />

          <AutomationTargetFields
            section="step"
            model={model}
            state={state}
            providerSnapshot={providerSnapshot}
            controlSize={controlSize}
            mutationServerId={mutationServerId}
          />
        </>
      )}

      <StepActions model={model} state={state} link={link} onStartLink={handleStartLink} />

      {linkError ? <Text style={styles.submitError}>{linkError}</Text> : null}

      {state.flowError ? (
        <Text style={styles.submitError} testID="automation-flow-error">
          {state.flowError}
        </Text>
      ) : null}

      <Field label="Max runs">
        <FormTextInput
          size={controlSize}
          testID="automation-max-runs-input"
          accessibilityLabel="Max runs"
          initialValue={state.maxRuns}
          onChangeText={model.setMaxRuns}
          placeholder="Unlimited"
          keyboardType="number-pad"
        />
      </Field>

      {state.submitError ? <Text style={styles.submitError}>{state.submitError}</Text> : null}
    </>
  );
}

interface StepLink {
  from: string;
  branch?: AutomationEdgeBranch;
}

// The references the selected agent step's prompt can use.
function promptHint(state: AutomationFormState): string | undefined {
  const upstream = upstreamNodeIds({ nodes: [], edges: state.edges }, state.agentStepId);
  const refs = state.steps
    .filter((step) => step.kind === "agent" && upstream.has(step.id))
    .map((step) => stepOutputReference(step.id));
  if (state.triggerKind === "pull_request") {
    refs.push("{{trigger.url}}", "{{trigger.number}}", "{{trigger.title}}", "{{trigger.headRef}}");
  }
  return refs.length > 0 ? `Can use ${refs.join(", ")}` : undefined;
}

const PULL_REQUEST_EVENTS: { value: PullRequestEvent; label: string }[] = [
  { value: "opened", label: "Opened" },
  { value: "synchronize", label: "New commits" },
  { value: "review_requested", label: "Review requested from me" },
];

function PullRequestTriggerFields({
  model,
  state,
  size,
}: {
  model: AutomationFormModel;
  state: AutomationFormState;
  size: ControlSize;
}): ReactElement {
  return (
    <>
      <Field
        label="Repository"
        hint="owner/name on GitHub. Checked every minute with the host's gh CLI; open pull requests fire only once they change."
      >
        <FormTextInput
          size={size}
          testID="automation-pr-repo-input"
          accessibilityLabel="Repository"
          initialValue={state.prRepo}
          onChangeText={model.setPrRepo}
          placeholder="owner/name"
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>
      <Field label="Run when a pull request is">
        <View style={styles.chipRow}>
          {PULL_REQUEST_EVENTS.map((event) => (
            <PullRequestEventChip
              key={event.value}
              event={event.value}
              label={event.label}
              selected={state.prEvents.includes(event.value)}
              onToggle={model.togglePrEvent}
            />
          ))}
        </View>
      </Field>
    </>
  );
}

function PullRequestEventChip({
  event,
  label,
  selected,
  onToggle,
}: {
  event: PullRequestEvent;
  label: string;
  selected: boolean;
  onToggle: (event: PullRequestEvent) => void;
}): ReactElement {
  const handlePress = useCallback(() => onToggle(event), [event, onToggle]);
  return (
    <Button
      size="sm"
      variant={selected ? "default" : "outline"}
      onPress={handlePress}
      testID={`automation-pr-event-${event}`}
    >
      {label}
    </Button>
  );
}

const STEP_STATUS_LABEL: Record<AutomationRun["status"], string> = {
  running: "is running",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "was cancelled",
};

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

// The graph, with the latest run's step results over it when editing.
function AutomationStepsSection({
  state,
  automation,
  serverId,
  linkFromStepId,
  onPressStep,
}: {
  state: AutomationFormState;
  automation: Automation | undefined;
  serverId: string;
  linkFromStepId: string | null;
  onPressStep: (stepId: string) => void;
}): ReactElement | null {
  const [shownRunId, setShownRunId] = useState(automation?.lastRun?.id);
  const run = useShownRun({ serverId, automationId: automation?.id, runId: shownRunId });
  const { retryAutomationRun, isRetrying } = useAutomationMutations({ serverId });
  const [retryError, setRetryError] = useState<string | null>(null);
  const handleRetry = useCallback(async () => {
    if (!automation || !run) {
      return;
    }
    setRetryError(null);
    try {
      const next = await retryAutomationRun({ automationId: automation.id, runId: run.id });
      setShownRunId(next.id);
    } catch (error) {
      setRetryError(toErrorMessage(error));
    }
  }, [automation, retryAutomationRun, run]);
  const handleRetryPress = useCallback(() => void handleRetry(), [handleRetry]);
  const canvasSteps = useMemo<AutomationCanvasStep[]>(
    () =>
      state.steps.map((step) => ({
        id: step.id,
        kind: step.kind,
        title: step.title || step.id,
        subtitle:
          step.kind === "agent"
            ? step.model || step.provider || "Choose a model"
            : `${step.operator.replace("_", " ")} ${step.value}`.trim(),
      })),
    [state.steps],
  );
  const stepStatuses = useMemo(
    () => (run ? Object.fromEntries(run.steps.map((step) => [step.nodeId, step.status])) : {}),
    [run],
  );
  const showCanvas = state.steps.length > 1 || (run?.steps.length ?? 0) > 1;
  if (!showCanvas && !run) {
    return null;
  }
  const canRetry =
    run &&
    (run.status === "failed" || run.status === "cancelled") &&
    automation?.status === "active";
  return (
    <View style={styles.stepsSection}>
      {run ? (
        <View style={styles.runBar}>
          <Text style={styles.runText} numberOfLines={2} testID="automation-run-status">
            {run.cause.kind === "retry" ? "Retry" : "Last run"} {STEP_STATUS_LABEL[run.status]}
            {run.error ? `: ${run.error}` : ""}
          </Text>
          {canRetry ? (
            <Button
              size="sm"
              variant="outline"
              loading={isRetrying}
              onPress={handleRetryPress}
              testID="automation-run-retry"
            >
              Retry
            </Button>
          ) : null}
        </View>
      ) : null}
      {retryError ? <Text style={styles.submitError}>{retryError}</Text> : null}
      {showCanvas ? (
        <AutomationFlowCanvas
          steps={canvasSteps}
          edges={state.edges}
          selectedStepId={state.selectedStepId}
          stepStatuses={stepStatuses}
          linkFromStepId={linkFromStepId}
          onPressStep={onPressStep}
        />
      ) : null}
    </View>
  );
}

const CONDITION_OPERATORS: { value: AutomationConditionOperator; label: string }[] = [
  { value: "contains", label: "contains" },
  { value: "not_contains", label: "does not contain" },
  { value: "equals", label: "equals" },
  { value: "not_equals", label: "does not equal" },
  { value: "matches", label: "matches regex" },
  { value: "is_empty", label: "is empty" },
  { value: "not_empty", label: "is not empty" },
];

const CONDITION_OPERATOR_OPTIONS: SelectFieldOption<AutomationConditionOperator>[] =
  CONDITION_OPERATORS.map((operator) => ({
    id: operator.value,
    value: operator.value,
    label: operator.label,
    testID: `automation-condition-operator-${operator.value}`,
  }));

function ConditionStepFields({
  model,
  step,
  size,
}: {
  model: AutomationFormModel;
  step: AutomationFormConditionStep;
  size: ControlSize;
}): ReactElement {
  const operatorDisplay = useMemo<SelectFieldDisplay>(
    () => ({
      label:
        CONDITION_OPERATORS.find((operator) => operator.value === step.operator)?.label ??
        step.operator,
    }),
    [step.operator],
  );
  const needsValue = step.operator !== "is_empty" && step.operator !== "not_empty";
  const handleInput = useCallback((input: string) => model.setCondition({ input }), [model]);
  const handleOperator = useCallback(
    (operator: AutomationConditionOperator) => model.setCondition({ operator }),
    [model],
  );
  const handleValue = useCallback((value: string) => model.setCondition({ value }), [model]);
  return (
    <>
      <Field label="Check" hint="Usually {{steps.<id>.output}} of the step before it">
        <FormTextInput
          size={size}
          testID="automation-condition-input"
          accessibilityLabel="Check input"
          initialValue={step.input}
          onChangeText={handleInput}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>
      <SelectField
        label="Test"
        value={step.operator}
        selectedDisplay={operatorDisplay}
        options={CONDITION_OPERATOR_OPTIONS}
        onChange={handleOperator}
        placeholder="Select test"
        emptyText="No tests"
        searchable={false}
        title="Test"
        size={size}
        triggerTestID="automation-condition-operator"
      />
      {needsValue ? (
        <Field
          label="Value"
          hint="Text tests ignore case and surrounding spaces. Links marked yes run when the test passes, no when it fails."
        >
          <FormTextInput
            size={size}
            testID="automation-condition-value"
            accessibilityLabel="Value"
            initialValue={step.value}
            onChangeText={handleValue}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </Field>
      ) : null}
    </>
  );
}

function StepActions({
  model,
  state,
  link,
  onStartLink,
}: {
  model: AutomationFormModel;
  state: AutomationFormState;
  link: StepLink | null;
  onStartLink: (link: StepLink | null) => void;
}): ReactElement {
  const selected = state.steps.find((step) => step.id === state.selectedStepId);
  const agentCount = state.steps.filter((step) => step.kind === "agent").length;
  const canRemove = state.steps.length > 1 && !(selected?.kind === "agent" && agentCount === 1);
  const outgoing = state.edges.filter((edge) => edge.from === state.selectedStepId);
  const selectedId = selected?.id ?? "";
  const handleAddAgent = useCallback(() => model.addStep("agent"), [model]);
  const handleAddCheck = useCallback(() => model.addStep("condition"), [model]);
  const handleLinkYes = useCallback(
    () => onStartLink({ from: selectedId, branch: "true" }),
    [onStartLink, selectedId],
  );
  const handleLinkNo = useCallback(
    () => onStartLink({ from: selectedId, branch: "false" }),
    [onStartLink, selectedId],
  );
  const handleLink = useCallback(
    () => onStartLink({ from: selectedId }),
    [onStartLink, selectedId],
  );
  const handleCancelLink = useCallback(() => onStartLink(null), [onStartLink]);
  const handleRemove = useCallback(() => model.removeStep(selectedId), [model, selectedId]);
  if (link) {
    return (
      <View style={styles.chipRow}>
        <Text style={styles.linkHint}>
          Tap the step that runs {link.branch === "false" ? "when the check fails" : "next"}
        </Text>
        <Button size="sm" variant="ghost" onPress={handleCancelLink}>
          Cancel
        </Button>
      </View>
    );
  }
  const linkable = state.steps.length > 1;
  return (
    <View style={styles.stepActions}>
      {outgoing.map((edge) => (
        <OutgoingLink
          key={`${edge.to}:${edge.branch ?? ""}`}
          edge={edge}
          targetTitle={state.steps.find((step) => step.id === edge.to)?.title || edge.to}
          onUnlink={model.disconnectSteps}
        />
      ))}
      <View style={styles.chipRow}>
        <Button size="sm" variant="outline" onPress={handleAddAgent} testID="automation-add-step">
          Add step
        </Button>
        <Button size="sm" variant="outline" onPress={handleAddCheck} testID="automation-add-check">
          Add check
        </Button>
        {linkable && selected?.kind === "condition" ? (
          <>
            <Button
              size="sm"
              variant="outline"
              onPress={handleLinkYes}
              testID="automation-link-yes"
            >
              If yes, link to…
            </Button>
            <Button size="sm" variant="outline" onPress={handleLinkNo} testID="automation-link-no">
              If no, link to…
            </Button>
          </>
        ) : null}
        {linkable && selected?.kind === "agent" ? (
          <Button size="sm" variant="outline" onPress={handleLink} testID="automation-link">
            Link to…
          </Button>
        ) : null}
        {canRemove ? (
          <Button size="sm" variant="ghost" onPress={handleRemove} testID="automation-remove-step">
            Remove step
          </Button>
        ) : null}
      </View>
    </View>
  );
}

const BRANCH_PREFIX: Record<AutomationEdgeBranch | "always", string> = {
  true: "If yes, then ",
  false: "If no, then ",
  always: "Then ",
};

function OutgoingLink({
  edge,
  targetTitle,
  onUnlink,
}: {
  edge: AutomationEdge;
  targetTitle: string;
  onUnlink: (edge: AutomationEdge) => void;
}): ReactElement {
  const handleUnlink = useCallback(() => onUnlink(edge), [edge, onUnlink]);
  return (
    <View style={styles.outgoingRow}>
      <Text style={styles.outgoingText} numberOfLines={1}>
        {BRANCH_PREFIX[edge.branch ?? "always"]}
        {targetTitle}
      </Text>
      <Button
        size="sm"
        variant="ghost"
        onPress={handleUnlink}
        testID={`automation-unlink-${edge.from}-${edge.to}`}
      >
        Unlink
      </Button>
    </View>
  );
}

const NO_PROFILE_VALUE = "__none__";

// Profiles live on a host, so the list follows the selected host. A stored or template profile the
// host does not have is dropped, which also repairs an automation whose profile was deleted.
function AutomationProfileField({
  serverId,
  value,
  onChange,
  size,
}: {
  serverId: string | null;
  value: string;
  onChange: (profileId: string) => void;
  size: ControlSize;
}): ReactElement {
  const { t } = useTranslation();
  const { profiles } = useAgentProfiles(serverId);
  useEffect(() => {
    if (profiles && value && !profiles.some((profile) => profile.id === value)) {
      onChange("");
    }
  }, [onChange, profiles, value]);
  const options = useMemo<SelectFieldOption<string>[]>(
    () => [
      {
        id: NO_PROFILE_VALUE,
        value: NO_PROFILE_VALUE,
        label: t("profiles.automationNoProfile"),
        testID: "automation-profile-option-none",
      },
      ...(profiles ?? []).map((profile) => ({
        id: profile.id,
        value: profile.id,
        label: profile.name,
        description: profile.notes,
        testID: `automation-profile-option-${profile.id}`,
      })),
    ],
    [profiles, t],
  );
  const selected = profiles?.find((profile) => profile.id === value) ?? null;
  const selectedDisplay = useMemo<SelectFieldDisplay>(
    () => ({ label: selected?.name ?? t("profiles.automationNoProfile") }),
    [selected, t],
  );
  const handleChange = useCallback(
    (next: string) => onChange(next === NO_PROFILE_VALUE ? "" : next),
    [onChange],
  );
  return (
    <SelectField
      label={t("profiles.automationProfileLabel")}
      hint={t("profiles.automationProfileHint")}
      value={selected ? selected.id : NO_PROFILE_VALUE}
      selectedDisplay={selectedDisplay}
      options={options}
      onChange={handleChange}
      placeholder={t("profiles.automationNoProfile")}
      emptyText={t("profiles.empty")}
      loading={serverId !== null && profiles === null}
      disabled={!serverId}
      searchable={options.length > 7}
      title={t("profiles.automationProfileLabel")}
      size={size}
      triggerTestID="automation-profile-trigger"
    />
  );
}

interface AutomationTargetFieldsProps {
  /** `automation`: host, project and isolation. `step`: the selected agent step's model fields. */
  section: "automation" | "step";
  model: AutomationFormModel;
  state: AutomationFormState;
  providerSnapshot: ReturnType<typeof useAutomationFormProviderSnapshot>;
  controlSize: ControlSize;
  mutationServerId: string;
}

function AutomationTargetFields({
  section,
  model,
  state,
  providerSnapshot,
  controlSize,
  mutationServerId,
}: AutomationTargetFieldsProps): ReactElement {
  const hostOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      state.hosts.map((host) => ({
        id: host.serverId,
        value: host.serverId,
        label: host.label,
        testID: buildAutomationHostOptionTestId(host.serverId),
      })),
    [state.hosts],
  );
  const selectedHost = state.hosts.find((host) => host.serverId === state.selectedServerId) ?? null;
  const selectedHostDisplay = useMemo<SelectFieldDisplay | null>(() => {
    if (selectedHost) {
      return { label: selectedHost.label };
    }
    if (state.selectedServerId) {
      return { label: state.selectedServerId };
    }
    return null;
  }, [selectedHost, state.selectedServerId]);
  const projectOptions = state.projectOptions;
  const modeOptions = useMemo<SelectFieldOption<string>[]>(
    () => [
      {
        id: "automation-mode-unattended",
        value: "",
        label: UNATTENDED_MODE_LABEL,
        description: "Runs without asking for permission",
      },
      ...state.modeOptions.map((option) => ({
        id: option.id,
        value: option.id,
        label: option.label,
      })),
    ],
    [state.modeOptions],
  );
  const thinkingOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      state.availableThinkingOptions.map((option) => ({
        id: option.id,
        value: option.id,
        label: formatThinkingOptionLabel(option),
        testID: buildThinkingOptionTestId(option.id),
      })),
    [state.availableThinkingOptions],
  );
  const handleSelectHost = useCallback(
    (nextServerId: string) => {
      model.setHost(nextServerId);
    },
    [model],
  );
  const handleSelectProject = useCallback(
    (optionId: string, display: AutomationFormDisplay) => {
      model.setProject(optionId, display);
    },
    [model],
  );
  const handleSelectModel = useCallback(
    (provider: AgentProvider, modelId: string) => {
      model.setModel(provider, modelId);
    },
    [model],
  );
  const handleSelectMode = useCallback(
    (modeId: string) => {
      model.setSessionMode(modeId);
    },
    [model],
  );
  const handleSelectThinking = useCallback(
    (thinkingOptionId: string) => {
      model.setThinking(thinkingOptionId);
    },
    [model],
  );
  const handleModelOpen = useCallback(() => {
    providerSnapshot.refetchIfStale(state.selectedProvider);
  }, [providerSnapshot, state.selectedProvider]);
  const handleRetryProvider = useCallback(
    (provider: AgentProvider) => {
      void providerSnapshot.refresh([provider]);
    },
    [providerSnapshot],
  );
  const renderHostOption = useCallback(
    (input: SelectFieldRenderOptionInput<string>) => <HostOptionItem {...input} />,
    [],
  );
  const renderProjectOption = useCallback(
    (input: SelectFieldRenderOptionInput<string>) => <ProjectOptionItem {...input} />,
    [],
  );
  const renderThinkingOption = useCallback(
    (input: SelectFieldRenderOptionInput<string>) => <ThinkingOptionItem {...input} />,
    [],
  );
  const modelTriggerLeading = useMemo(
    () => <ProviderGlyph provider={state.selectedProvider} serverId={state.selectedServerId} />,
    [state.selectedProvider, state.selectedServerId],
  );
  const renderModelTrigger = useCallback(
    ({
      selectedModelLabel,
      disabled,
      isOpen,
      hovered,
      pressed,
    }: {
      selectedModelLabel: string;
      onPress: () => void;
      disabled: boolean;
      isOpen: boolean;
      hovered: boolean;
      pressed: boolean;
    }): ReactNode => {
      const displayLabel = state.selectedModelDisplay?.label ?? selectedModelLabel;
      return (
        <SelectFieldTrigger
          label={displayLabel}
          isPlaceholder={!state.selectedModel}
          placeholder={displayLabel}
          leading={modelTriggerLeading}
          disabled={disabled}
          active={hovered || pressed || isOpen}
          size={controlSize}
          testID="automation-model-trigger"
        />
      );
    },
    [controlSize, modelTriggerLeading, state.selectedModel, state.selectedModelDisplay],
  );

  if (section === "step") {
    return (
      <>
        {state.disclosure.showModelField ? (
          <Field label="Model">
            <CombinedModelSelector
              providers={state.modelSelectorProviders}
              selectedProvider={state.selectedProvider ?? ""}
              selectedModel={state.selectedModel}
              onSelect={handleSelectModel}
              isLoading={providerSnapshot.isLoading || providerSnapshot.isFetching}
              renderTrigger={renderModelTrigger}
              triggerFill
              serverId={mutationServerId}
              disabled={!state.selectedServerId}
              onOpen={handleModelOpen}
              onRetryProvider={handleRetryProvider}
              isRetryingProvider={providerSnapshot.isRefreshing}
            />
          </Field>
        ) : null}

        {state.disclosure.showThinkingField ? (
          <SelectField
            label="Thinking"
            value={state.selectedThinkingOptionId || null}
            selectedDisplay={state.selectedThinkingDisplay}
            options={thinkingOptions}
            onChange={handleSelectThinking}
            placeholder="Select thinking"
            emptyText="No thinking options found"
            searchable={thinkingOptions.length > 6}
            title="Select thinking"
            size={controlSize}
            triggerTestID="automation-thinking-trigger"
            renderOption={renderThinkingOption}
          />
        ) : null}

        {state.disclosure.showModeField ? (
          <SelectField
            label="Mode"
            value={state.selectedMode}
            selectedDisplay={state.selectedModeDisplay}
            options={modeOptions}
            onChange={handleSelectMode}
            placeholder={UNATTENDED_MODE_LABEL}
            emptyText="No modes found"
            searchable={modeOptions.length > 7}
            title="Select mode"
            size={controlSize}
            triggerTestID="automation-mode-trigger"
          />
        ) : null}
      </>
    );
  }

  return (
    <>
      {state.mode === "edit" || state.hosts.length > 1 ? (
        <SelectField
          label="Host"
          value={state.selectedServerId}
          selectedDisplay={selectedHostDisplay}
          options={hostOptions}
          onChange={handleSelectHost}
          placeholder="Select host"
          emptyText="No hosts found"
          disabled={state.mode === "edit"}
          searchable={false}
          title="Host"
          size={controlSize}
          triggerTestID="automation-host-trigger"
          renderOption={renderHostOption}
        />
      ) : null}

      {state.disclosure.showProjectField ? (
        <SelectField
          label="Project"
          value={state.selectedProjectOptionId || null}
          selectedDisplay={state.projectDisplay}
          options={projectOptions}
          onChange={handleSelectProject}
          placeholder="Select project"
          emptyText="No projects found"
          disabled={!state.selectedServerId}
          hint={!state.selectedServerId ? "Choose a host first." : undefined}
          searchable
          searchPlaceholder="Search projects..."
          title="Select project"
          size={controlSize}
          triggerTestID="automation-project-trigger"
          renderOption={renderProjectOption}
        />
      ) : null}

      {state.disclosure.showIsolationField ? (
        <AutomationIsolationField model={model} state={state} size={controlSize} />
      ) : null}
    </>
  );
}

function AutomationIsolationField({
  model,
  state,
  size,
}: {
  model: AutomationFormModel;
  state: AutomationFormState;
  size: ControlSize;
}): ReactElement {
  const options = useMemo<SelectFieldOption<"local" | "worktree">[]>(
    () => [
      {
        id: "local",
        value: "local",
        label: "Local",
        testID: "automation-isolation-local",
      },
      {
        id: "worktree",
        value: "worktree",
        label: "Worktree",
        testID: "automation-isolation-worktree",
      },
    ],
    [],
  );
  const selectedDisplay = useMemo<SelectFieldDisplay>(
    () => ({ label: state.effectiveIsolation === "worktree" ? "Worktree" : "Local" }),
    [state.effectiveIsolation],
  );
  const triggerLeading = useMemo(
    () => (
      <View style={styles.optionIconBox}>
        {state.effectiveIsolation === "worktree" ? (
          <GitBranch size={16} color={styles.providerIcon.color} />
        ) : (
          <Folder size={16} color={styles.providerIcon.color} />
        )}
      </View>
    ),
    [state.effectiveIsolation],
  );
  const handleSelectIsolation = useCallback(
    (value: "local" | "worktree") => {
      model.setIsolation(value);
    },
    [model],
  );
  const renderIsolationOption = useCallback(
    (input: SelectFieldRenderOptionInput<"local" | "worktree">) => (
      <IsolationOptionItem {...input} />
    ),
    [],
  );

  return (
    <SelectField
      label="Isolation"
      value={state.effectiveIsolation}
      selectedDisplay={selectedDisplay}
      options={options}
      onChange={handleSelectIsolation}
      placeholder="Select isolation"
      emptyText="No isolation options found"
      searchable={false}
      title="Isolation"
      size={size}
      testID="automation-isolation"
      triggerTestID="automation-isolation-trigger"
      triggerLeading={triggerLeading}
      renderOption={renderIsolationOption}
    />
  );
}

function IsolationOptionItem({
  option,
  selected,
  active,
  onPress,
}: SelectFieldRenderOptionInput<"local" | "worktree">): ReactElement {
  const leadingSlot = useMemo(
    () => (
      <View style={styles.optionIconBox}>
        {option.value === "worktree" ? (
          <GitBranch size={16} color={styles.providerIcon.color} />
        ) : (
          <Folder size={16} color={styles.providerIcon.color} />
        )}
      </View>
    ),
    [option.value],
  );

  return (
    <ComboboxItem
      testID={option.testID}
      label={option.label}
      selected={selected}
      active={active}
      onPress={onPress}
      leadingSlot={leadingSlot}
    />
  );
}

function HostOptionItem({
  option,
  selected,
  active,
  onPress,
}: SelectFieldRenderOptionInput<string>): ReactElement {
  const leadingSlot = useMemo(() => <HostStatusDotSlot serverId={option.value} />, [option.value]);

  return (
    <ComboboxItem
      testID={option.testID}
      label={option.label}
      selected={selected}
      active={active}
      onPress={onPress}
      leadingSlot={leadingSlot}
    />
  );
}

function ProjectOptionItem({
  option,
  selected,
  active,
  onPress,
}: SelectFieldRenderOptionInput<string>): ReactElement {
  const leadingSlot = useMemo(
    () => (
      <View style={styles.optionIconBox}>
        <Folder size={16} color={styles.providerIcon.color} />
      </View>
    ),
    [],
  );

  return (
    <ComboboxItem
      testID={option.testID}
      label={option.label}
      selected={selected}
      active={active}
      onPress={onPress}
      leadingSlot={leadingSlot}
    />
  );
}

function ThinkingOptionItem({
  option,
  selected,
  active,
  onPress,
}: SelectFieldRenderOptionInput<string>): ReactElement {
  const leadingSlot = useMemo(
    () => (
      <View style={styles.optionIconBox}>
        <Brain size={16} color={styles.providerIcon.color} />
      </View>
    ),
    [],
  );

  return (
    <ComboboxItem
      testID={option.testID}
      label={option.label}
      selected={selected}
      active={active}
      onPress={onPress}
      leadingSlot={leadingSlot}
    />
  );
}

function ProviderGlyph({
  provider,
  serverId,
}: {
  provider: string | null;
  serverId: string | null;
}): ReactElement | null {
  const Icon = useProviderIcon(provider ?? "", serverId);
  if (!provider) {
    return null;
  }
  return <Icon size={16} color={styles.providerIcon.color} />;
}

const styles = StyleSheet.create((theme) => {
  return {
    multilineInput: {
      minHeight: 96,
    },
    optionIconBox: {
      width: 18,
      height: 18,
      alignItems: "center",
      justifyContent: "center",
    },
    footer: {
      flex: 1,
      flexDirection: "row",
      gap: theme.spacing[3],
    },
    footerButton: {
      flex: 1,
    },
    submitError: {
      color: theme.colors.palette.red[300],
      fontSize: theme.fontSize.sm,
    },
    draftNotice: {
      color: theme.colors.foregroundMuted,
      fontSize: theme.fontSize.sm,
    },
    chipRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: theme.spacing[2],
    },
    stepsSection: {
      gap: theme.spacing[2],
    },
    runBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
    },
    runText: {
      flex: 1,
      color: theme.colors.foregroundMuted,
      fontSize: theme.fontSize.sm,
    },
    stepActions: {
      gap: theme.spacing[2],
    },
    outgoingRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
    },
    outgoingText: {
      flex: 1,
      color: theme.colors.foreground,
      fontSize: theme.fontSize.sm,
    },
    linkHint: {
      color: theme.colors.foreground,
      fontSize: theme.fontSize.sm,
    },
    providerIcon: {
      color: theme.colors.foregroundMuted,
    },
  };
});
