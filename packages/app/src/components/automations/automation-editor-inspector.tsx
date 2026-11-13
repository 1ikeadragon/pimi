import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "@/i18n/use-translation";
import {
  AlertTriangle,
  Bot,
  Brain,
  Folder,
  Plus,
  RotateCcw,
  Split,
  Trash2,
  Zap,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { AgentProvider } from "@pimi/protocol/agent-types";
import type {
  AutomationConditionOperator,
  AutomationEdge,
  AutomationEdgeBranch,
  AutomationRun,
  PullRequestEvent,
} from "@pimi/protocol/automation/types";
import {
  conditionOperatorNeedsValue,
  evaluateAutomationCondition,
  PULL_REQUEST_TEMPLATE_FIELDS,
  stepOutputReference,
} from "@pimi/protocol/automation/validate";
import { formatThinkingOptionLabel } from "@/agent-controls/labels";
import { useAgentProfiles } from "@/agent-profiles";
import { CadenceEditor } from "@/components/automations/cadence-editor";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import { HostStatusDotSlot } from "@/components/hosts/host-picker";
import { useProviderIcon } from "@/components/provider-icons";
import { Button } from "@/components/ui/button";
import { ComboboxItem } from "@/components/ui/combobox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import {
  SelectField,
  SelectFieldTrigger,
  type SelectFieldDisplay,
  type SelectFieldOption,
  type SelectFieldRenderOptionInput,
} from "@/components/ui/select-field";
import type { EditingTextInputHandle } from "@/components/ui/text-input/types";
import {
  connectableTargets,
  effectiveStepModel,
  modelLabel,
  modeOptionsFor,
  thinkingOptionsFor,
  upstreamAgentSteps,
  TRIGGER_NODE_ID,
  type AutomationEditorModel,
  type AutomationEditorState,
  type EditorAgentStep,
  type EditorCheckStep,
  type EditorDefaults,
  type EditorProblem,
  type EditorStep,
  type EditorTriggerKind,
  type EditorWorkspace,
} from "@/automations/automation-editor-model";
import type { EditorProvidersSnapshot } from "@/automations/use-automation-editor-model";
import { everyMsToParts, partsToEveryMs, type IntervalUnit } from "@/utils/automation-format";
import {
  CHECK_OPERATORS,
  CHECK_PRESETS,
  CUSTOM_SOURCE,
  sourceStepId,
  type CheckPreset,
} from "@/automations/automation-check-presets";
import { confirmDialog } from "@/utils/confirm-dialog";
import { ConnectItem, problemKey, problemParams } from "./automation-editor-canvas";
import type { Theme } from "@/styles/theme";

// Module-scope themed icon so the connect trigger's `leading` is a stable element.
const ThemedPlus = withUnistyles(Plus);
const connectLeading = (
  <ThemedPlus uniProps={(theme: Theme) => ({ size: 14, color: theme.colors.foregroundMuted })} />
);

const SIZE = "md" as const;

export interface InspectorRunView {
  run: AutomationRun;
  /** Retries the shown run; its failed steps run again and the rest are reused. */
  onRetry: (() => void) | null;
  retrying: boolean;
  retryError: string | null;
}

export interface AutomationEditorInspectorProps {
  model: AutomationEditorModel;
  state: AutomationEditorState;
  providers: EditorProvidersSnapshot;
  runView: InspectorRunView | null;
}

/** The panel beside the canvas (a sheet on a phone): the selected node's settings, or the automation's. */
export function AutomationEditorInspector({
  model,
  state,
  providers,
  runView,
}: AutomationEditorInspectorProps): ReactElement {
  const selected =
    state.selection.kind === "step"
      ? (state.steps.find((step) => step.id === (state.selection as { id: string }).id) ?? null)
      : null;
  let body: ReactNode;
  if (state.selection.kind === "trigger") {
    body = <TriggerSection model={model} state={state} />;
  } else if (selected?.kind === "agent") {
    body = (
      <AgentStepSection
        key={selected.id}
        model={model}
        state={state}
        step={selected}
        providers={providers}
        runView={runView}
      />
    );
  } else if (selected?.kind === "condition") {
    body = (
      <CheckStepSection
        key={selected.id}
        model={model}
        state={state}
        step={selected}
        runView={runView}
      />
    );
  } else {
    body = <SettingsSection model={model} state={state} providers={providers} />;
  }
  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      testID="automation-inspector"
    >
      {body}
    </ScrollView>
  );
}

function SectionTitle({
  icon: Icon,
  children,
}: {
  icon: typeof Bot;
  children: string;
}): ReactElement {
  return (
    <View style={styles.sectionTitleRow}>
      <Icon size={16} color={styles.mutedIcon.color} />
      <Text style={styles.sectionTitle}>{children}</Text>
    </View>
  );
}

function ProblemList({
  problems,
}: {
  problems: readonly EditorProblem[] | undefined;
}): ReactElement | null {
  const { t } = useTranslation();
  if (!problems || problems.length === 0) {
    return null;
  }
  return (
    <View style={styles.problems} testID="automation-inspector-problems">
      {problems.map((problem) => (
        <View
          key={`${problem.code}:${problem.ref ?? ""}:${problem.message}`}
          style={styles.problemRow}
        >
          <AlertTriangle size={14} color={styles.problemText.color} />
          <Text style={styles.problemText}>
            {t(`automationEditor.problems.${problemKey(problem)}`, problemParams(problem))}
          </Text>
        </View>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Automation settings
// ---------------------------------------------------------------------------

function SettingsSection({
  model,
  state,
  providers,
}: {
  model: AutomationEditorModel;
  state: AutomationEditorState;
  providers: EditorProvidersSnapshot;
}): ReactElement {
  const { t } = useTranslation();
  const hostOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      state.hosts.map((host) => ({
        id: host.serverId,
        value: host.serverId,
        label: host.label,
        testID: `automation-host-option-${host.serverId}`,
      })),
    [state.hosts],
  );
  const host = state.hosts.find((candidate) => candidate.serverId === state.selectedServerId);
  const hostDisplay = useMemo<SelectFieldDisplay | null>(() => {
    const label = host?.label ?? state.selectedServerId;
    return label ? { label } : null;
  }, [host, state.selectedServerId]);
  const renderHostOption = useCallback(
    (input: SelectFieldRenderOptionInput<string>) => <HostOptionItem {...input} />,
    [],
  );
  const renderProjectOption = useCallback(
    (input: SelectFieldRenderOptionInput<string>) => <ProjectOptionItem {...input} />,
    [],
  );
  const handleProject = useCallback(
    (optionId: string, display: SelectFieldDisplay) =>
      model.setProject(optionId, { label: display.label ?? "" }),
    [model],
  );
  return (
    <>
      <SectionTitle icon={Folder}>{t("automationEditor.inspector.settingsTitle")}</SectionTitle>
      <ProblemList
        problems={[
          ...(state.problemsByTarget.get("settings") ?? []),
          ...(state.problemsByTarget.get("name") ?? []),
        ]}
      />
      {state.mode === "edit" || state.hosts.length > 1 ? (
        <SelectField
          label={t("automationEditor.inspector.host")}
          value={state.selectedServerId}
          selectedDisplay={hostDisplay}
          options={hostOptions}
          onChange={model.setHost}
          placeholder={t("automationEditor.inspector.selectHost")}
          emptyText={t("automationEditor.inspector.noHosts")}
          disabled={state.mode === "edit"}
          searchable={false}
          title={t("automationEditor.inspector.host")}
          size={SIZE}
          triggerTestID="automation-host-trigger"
          renderOption={renderHostOption}
        />
      ) : null}
      <SelectField
        label={t("automationEditor.inspector.project")}
        value={state.selectedProjectOptionId || null}
        selectedDisplay={state.projectDisplay}
        options={state.projectOptions}
        onChange={handleProject}
        placeholder={t("automationEditor.inspector.selectProject")}
        emptyText={t("automationEditor.inspector.noProjects")}
        disabled={!state.selectedServerId}
        hint={!state.selectedServerId ? t("automationEditor.inspector.chooseHost") : undefined}
        searchable
        searchPlaceholder={t("automationEditor.inspector.searchProjects")}
        title={t("automationEditor.inspector.selectProject")}
        size={SIZE}
        triggerTestID="automation-project-trigger"
        renderOption={renderProjectOption}
      />
      <Field
        label={t("automationEditor.inspector.defaultsTitle")}
        hint={t("automationEditor.inspector.defaultsHint")}
      >
        <ModelFields
          serverId={state.selectedServerId}
          state={state}
          providers={providers}
          value={state.defaults}
          onModel={model.setDefaultModel}
          onThinking={model.setDefaultThinking}
          onMode={model.setDefaultMode}
          testIDPrefix="automation-default"
        />
      </Field>
      <Field label={t("automationEditor.inspector.maxRuns")}>
        <FormTextInput
          size={SIZE}
          testID="automation-max-runs-input"
          accessibilityLabel={t("automationEditor.inspector.maxRuns")}
          initialValue={state.maxRuns}
          onChangeText={model.setMaxRuns}
          placeholder={t("automationEditor.inspector.unlimited")}
          keyboardType="number-pad"
        />
      </Field>
    </>
  );
}

// ---------------------------------------------------------------------------
// Model fields
// ---------------------------------------------------------------------------

function ModelFields({
  serverId,
  state,
  providers,
  value,
  onModel,
  onThinking,
  onMode,
  testIDPrefix,
}: {
  serverId: string | null;
  state: AutomationEditorState;
  providers: EditorProvidersSnapshot;
  value: EditorDefaults;
  onModel: (provider: AgentProvider, modelId: string) => void;
  onThinking: (thinkingOptionId: string) => void;
  onMode: (modeId: string) => void;
  testIDPrefix: string;
}): ReactElement {
  const { t } = useTranslation();
  const thinking = thinkingOptionsFor(state.providerEntries, value.provider, value.model);
  const modes = modeOptionsFor(state.providerEntries, value.provider);
  const thinkingOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      thinking.map((option) => ({
        id: option.id,
        value: option.id,
        label: formatThinkingOptionLabel(option),
        testID: `${testIDPrefix}-thinking-option-${option.id}`,
      })),
    [testIDPrefix, thinking],
  );
  const modeOptions = useMemo<SelectFieldOption<string>[]>(
    () => [
      {
        id: "unattended",
        value: "",
        label: t("automationEditor.inspector.unattended"),
        description: t("automationEditor.inspector.unattendedHint"),
      },
      ...modes.map((mode) => ({ id: mode.id, value: mode.id, label: mode.label })),
    ],
    [modes, t],
  );
  const thinkingDisplay = useMemo<SelectFieldDisplay | null>(() => {
    const option = thinking.find((candidate) => candidate.id === value.thinkingOptionId);
    return option ? { label: formatThinkingOptionLabel(option) } : null;
  }, [thinking, value.thinkingOptionId]);
  const modeDisplay = useMemo<SelectFieldDisplay>(
    () => ({
      label:
        modes.find((mode) => mode.id === value.modeId)?.label ??
        t("automationEditor.inspector.unattended"),
    }),
    [modes, t, value.modeId],
  );
  const label = value.provider
    ? modelLabel(state.providerEntries, value.provider, value.model) || value.provider
    : t("automationEditor.inspector.selectModel");
  const leading = useMemo(
    () => <ProviderGlyph provider={value.provider} serverId={serverId} />,
    [serverId, value.provider],
  );
  const renderTrigger = useCallback(
    (input: {
      disabled: boolean;
      isOpen: boolean;
      hovered: boolean;
      pressed: boolean;
    }): ReactNode => (
      <SelectFieldTrigger
        label={label}
        isPlaceholder={!value.provider}
        placeholder={label}
        leading={leading}
        disabled={input.disabled}
        active={input.hovered || input.pressed || input.isOpen}
        size={SIZE}
        testID={`${testIDPrefix}-model-trigger`}
      />
    ),
    [label, leading, testIDPrefix, value.provider],
  );
  const handleOpen = useCallback(
    () => providers.refetchIfStale(value.provider),
    [providers, value.provider],
  );
  const handleRetryProvider = useCallback(
    (provider: AgentProvider) => void providers.refresh([provider]),
    [providers],
  );
  const renderThinkingOption = useCallback(
    (input: SelectFieldRenderOptionInput<string>) => <ThinkingOptionItem {...input} />,
    [],
  );
  return (
    <View style={styles.modelFields}>
      <CombinedModelSelector
        providers={state.modelSelectorProviders}
        selectedProvider={value.provider ?? ""}
        selectedModel={value.model}
        onSelect={onModel}
        isLoading={providers.isLoading || providers.isFetching}
        renderTrigger={renderTrigger}
        triggerFill
        serverId={serverId}
        disabled={!serverId || !state.workingDir.trim()}
        onOpen={handleOpen}
        onRetryProvider={handleRetryProvider}
        isRetryingProvider={providers.isRefreshing}
      />
      {thinkingOptions.length > 0 ? (
        <SelectField
          label={t("automationEditor.inspector.thinking")}
          value={value.thinkingOptionId || null}
          selectedDisplay={thinkingDisplay}
          options={thinkingOptions}
          onChange={onThinking}
          placeholder={t("automationEditor.inspector.thinking")}
          emptyText={t("automationEditor.inspector.thinking")}
          searchable={false}
          title={t("automationEditor.inspector.thinking")}
          size={SIZE}
          triggerTestID={`${testIDPrefix}-thinking-trigger`}
          renderOption={renderThinkingOption}
        />
      ) : null}
      {value.provider ? (
        <SelectField
          label={t("automationEditor.inspector.mode")}
          value={value.modeId}
          selectedDisplay={modeDisplay}
          options={modeOptions}
          onChange={onMode}
          placeholder={t("automationEditor.inspector.unattended")}
          emptyText={t("automationEditor.inspector.unattended")}
          searchable={modeOptions.length > 7}
          title={t("automationEditor.inspector.mode")}
          size={SIZE}
          triggerTestID={`${testIDPrefix}-mode-trigger`}
        />
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

const TRIGGER_KINDS: EditorTriggerKind[] = ["manual", "cron", "interval", "pull_request"];
const INTERVAL_UNITS: IntervalUnit[] = ["minutes", "hours", "days"];
const PR_EVENTS: { value: PullRequestEvent; key: "prOpened" | "prSync" | "prReview" }[] = [
  { value: "opened", key: "prOpened" },
  { value: "synchronize", key: "prSync" },
  { value: "review_requested", key: "prReview" },
];

function TriggerSection({
  model,
  state,
}: {
  model: AutomationEditorModel;
  state: AutomationEditorState;
}): ReactElement {
  const { t } = useTranslation();
  const options = useMemo<SelectFieldOption<EditorTriggerKind>[]>(
    () =>
      TRIGGER_KINDS.map((kind) => ({
        id: kind,
        value: kind,
        label: t(`automationEditor.triggerKinds.${kind}`),
        testID: `automation-trigger-${kind}`,
      })),
    [t],
  );
  const display = useMemo<SelectFieldDisplay>(
    () => ({ label: t(`automationEditor.triggerKinds.${state.triggerKind}`) }),
    [state.triggerKind, t],
  );
  const cronProblem = state.problemsByTarget
    .get(TRIGGER_NODE_ID)
    ?.find((problem) => problem.code === "invalid_cron");
  return (
    <>
      <SectionTitle icon={Zap}>{t("automationEditor.inspector.triggerTitle")}</SectionTitle>
      <Text style={styles.hint}>{t("automationEditor.inspector.triggerHint")}</Text>
      <ProblemList problems={state.problemsByTarget.get(TRIGGER_NODE_ID)} />
      <SelectField
        label={t("automationEditor.inspector.triggerKind")}
        value={state.triggerKind}
        selectedDisplay={display}
        options={options}
        onChange={model.setTriggerKind}
        placeholder={t("automationEditor.inspector.triggerKind")}
        emptyText={t("automationEditor.inspector.triggerKind")}
        searchable={false}
        title={t("automationEditor.inspector.triggerKind")}
        size={SIZE}
        triggerTestID="automation-trigger-kind"
      />
      {state.triggerKind === "cron" ? (
        <CadenceEditor
          value={state.cron}
          onChange={model.setCron}
          error={cronProblem?.cronError}
          size={SIZE}
        />
      ) : null}
      {state.triggerKind === "interval" ? (
        <IntervalFields model={model} intervalMs={state.intervalMs} />
      ) : null}
      {state.triggerKind === "pull_request" ? (
        <PullRequestFields model={model} state={state} />
      ) : null}
    </>
  );
}

function IntervalFields({
  model,
  intervalMs,
}: {
  model: AutomationEditorModel;
  intervalMs: number;
}): ReactElement {
  const { t } = useTranslation();
  const parts = everyMsToParts(intervalMs);
  const unitOptions = useMemo<SegmentedControlOption<IntervalUnit>[]>(
    () =>
      INTERVAL_UNITS.map((unit) => ({
        value: unit,
        label: t(`automationEditor.units.${unit}`),
        testID: `automation-interval-${unit}`,
      })),
    [t],
  );
  const handleValue = useCallback(
    (text: string) => {
      const value = Number.parseInt(text, 10);
      if (Number.isFinite(value) && value > 0) {
        model.setIntervalMs(partsToEveryMs(value, parts.unit));
      }
    },
    [model, parts.unit],
  );
  const handleUnit = useCallback(
    (unit: IntervalUnit) => model.setIntervalMs(partsToEveryMs(parts.value, unit)),
    [model, parts.value],
  );
  return (
    <Field label={t("automationEditor.inspector.every")}>
      <View style={styles.row}>
        <View style={styles.intervalInput}>
          <FormTextInput
            size={SIZE}
            testID="automation-interval-value"
            accessibilityLabel={t("automationEditor.inspector.every")}
            initialValue={String(parts.value)}
            onChangeText={handleValue}
            keyboardType="number-pad"
          />
        </View>
        <SegmentedControl
          options={unitOptions}
          value={parts.unit}
          onValueChange={handleUnit}
          size={SIZE}
        />
      </View>
    </Field>
  );
}

function PullRequestFields({
  model,
  state,
}: {
  model: AutomationEditorModel;
  state: AutomationEditorState;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <>
      <Field
        label={t("automationEditor.inspector.repo")}
        hint={t("automationEditor.inspector.repoHint")}
      >
        <FormTextInput
          size={SIZE}
          testID="automation-pr-repo-input"
          accessibilityLabel={t("automationEditor.inspector.repo")}
          initialValue={state.prRepo}
          onChangeText={model.setPrRepo}
          placeholder="owner/name"
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>
      <Field label={t("automationEditor.inspector.prEvents")}>
        <View style={styles.chipRow}>
          {PR_EVENTS.map((event) => (
            <PrEventChip
              key={event.value}
              event={event.value}
              label={t(`automationEditor.inspector.${event.key}`)}
              selected={state.prEvents.includes(event.value)}
              onToggle={model.togglePrEvent}
            />
          ))}
        </View>
      </Field>
    </>
  );
}

function PrEventChip({
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

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** References a step's text can use: earlier agent steps' output, and the pull request's fields. */
function useInsertableReferences(
  state: AutomationEditorState,
  stepId: string,
): { ref: string; label: string }[] {
  const { t } = useTranslation();
  return useMemo(() => {
    const refs = upstreamAgentSteps(state, stepId).map((step) => ({
      ref: stepOutputReference(step.id),
      label: t("automationEditor.inspector.outputOf", { title: step.title || step.id }),
    }));
    if (state.triggerKind === "pull_request") {
      for (const field of PULL_REQUEST_TEMPLATE_FIELDS) {
        refs.push({
          ref: `{{trigger.${field}}}`,
          label: t("automationEditor.inspector.prField", { field }),
        });
      }
    }
    return refs;
  }, [state, stepId, t]);
}

function InsertReferenceMenu({
  references,
  onInsert,
}: {
  references: { ref: string; label: string }[];
  onInsert: (ref: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownTrigger
        accessibilityRole="button"
        accessibilityLabel={t("automationEditor.inspector.insertOutput")}
        testID="automation-insert-reference"
        disabled={references.length === 0}
      >
        {t("automationEditor.inspector.insertOutput")}
      </DropdownTrigger>
      <DropdownMenuContent
        align="end"
        width={260}
        sheetTitle={t("automationEditor.inspector.insertOutput")}
      >
        {references.map((reference) => (
          <ReferenceItem key={reference.ref} reference={reference} onInsert={onInsert} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ReferenceItem({
  reference,
  onInsert,
}: {
  reference: { ref: string; label: string };
  onInsert: (ref: string) => void;
}): ReactElement {
  const handleSelect = useCallback(() => onInsert(reference.ref), [onInsert, reference.ref]);
  return (
    <DropdownMenuItem
      description={reference.ref}
      onSelect={handleSelect}
      testID={`automation-reference-${reference.ref}`}
    >
      {reference.label}
    </DropdownMenuItem>
  );
}

function appendReference(text: string, ref: string): string {
  if (!text) return ref;
  return /\s$/.test(text) ? `${text}${ref}` : `${text} ${ref}`;
}

function AgentStepSection({
  model,
  state,
  step,
  providers,
  runView,
}: {
  model: AutomationEditorModel;
  state: AutomationEditorState;
  step: EditorAgentStep;
  providers: EditorProvidersSnapshot;
  runView: InspectorRunView | null;
}): ReactElement {
  const { t } = useTranslation();
  const promptRef = useRef<EditingTextInputHandle>(null);
  const references = useInsertableReferences(state, step.id);
  const handleTitle = useCallback(
    (title: string) => model.updateAgentStep(step.id, { title }),
    [model, step.id],
  );
  const handlePrompt = useCallback(
    (prompt: string) => model.updateAgentStep(step.id, { prompt }),
    [model, step.id],
  );
  const handleInsert = useCallback(
    (ref: string) => {
      const current = promptRef.current?.getText() ?? step.prompt;
      const next = appendReference(current, ref);
      // replaceText does not report a change on web, so the model is told directly.
      promptRef.current?.replaceText(next);
      model.updateAgentStep(step.id, { prompt: next });
      promptRef.current?.focus();
    },
    [model, step.id, step.prompt],
  );
  const insertMenu = useMemo(
    () => <InsertReferenceMenu references={references} onInsert={handleInsert} />,
    [handleInsert, references],
  );
  const handleProfile = useCallback(
    (profileId: string) => model.updateAgentStep(step.id, { profileId }),
    [model, step.id],
  );
  const workspaceOptions = useMemo<SegmentedControlOption<EditorWorkspace>[]>(
    () => [
      {
        value: "project",
        label: t("automationEditor.inspector.workspaceProject"),
        testID: "automation-workspace-project",
      },
      {
        value: "worktree",
        label: t("automationEditor.inspector.workspaceWorktree"),
        disabled: state.projectIsGit === false,
        testID: "automation-workspace-worktree",
      },
    ],
    [state.projectIsGit, t],
  );
  const handleWorkspace = useCallback(
    (workspace: EditorWorkspace) => model.updateAgentStep(step.id, { workspace }),
    [model, step.id],
  );
  const modelSource: "default" | "custom" = step.provider === null ? "default" : "custom";
  const sourceOptions = useMemo<SegmentedControlOption<"default" | "custom">[]>(
    () => [
      {
        value: "default",
        label: t("automationEditor.inspector.modelDefault"),
        testID: "automation-step-model-default",
      },
      {
        value: "custom",
        label: t("automationEditor.inspector.modelCustom"),
        testID: "automation-step-model-custom",
      },
    ],
    [t],
  );
  const handleSource = useCallback(
    (source: "default" | "custom") => {
      if (source === "default") {
        model.setStepModel(step.id, null, "");
        return;
      }
      const current = effectiveStepModel(step, state.defaults);
      if (current.provider) {
        model.setStepModel(step.id, current.provider, current.model);
      }
    },
    [model, state.defaults, step],
  );
  const handleStepModel = useCallback(
    (provider: AgentProvider, modelId: string) => model.setStepModel(step.id, provider, modelId),
    [model, step.id],
  );
  const handleStepThinking = useCallback(
    (id: string) => model.setStepThinking(step.id, id),
    [model, step.id],
  );
  const handleStepMode = useCallback(
    (id: string) => model.setStepMode(step.id, id),
    [model, step.id],
  );
  const handleDelete = useCallback(() => model.removeStep(step.id), [model, step.id]);
  const defaultLabel = state.defaults.provider
    ? modelLabel(state.providerEntries, state.defaults.provider, state.defaults.model) ||
      state.defaults.provider
    : t("automationEditor.nodes.noModel");
  return (
    <>
      <SectionTitle icon={Bot}>{t("automationEditor.inspector.stepTitle")}</SectionTitle>
      <ProblemList problems={state.problemsByTarget.get(step.id)} />
      <RunStepPanel stepId={step.id} runView={runView} />
      <Field label={t("automationEditor.inspector.name")}>
        <FormTextInput
          size={SIZE}
          testID="automation-step-title-input"
          accessibilityLabel={t("automationEditor.inspector.name")}
          initialValue={step.title}
          onChangeText={handleTitle}
          autoCorrect={false}
        />
      </Field>
      <Field label={t("automationEditor.inspector.prompt")} trailing={insertMenu}>
        <FormTextInput
          ref={promptRef}
          size={SIZE}
          testID="automation-prompt-input"
          accessibilityLabel={t("automationEditor.inspector.prompt")}
          initialValue={step.prompt}
          onChangeText={handlePrompt}
          placeholder={t("automationEditor.inspector.promptPlaceholder")}
          style={styles.multiline}
          multiline
          numberOfLines={6}
          textAlignVertical="top"
        />
      </Field>
      <ProfileField
        serverId={state.selectedServerId}
        value={step.profileId}
        onChange={handleProfile}
      />
      <Field label={t("automationEditor.inspector.model")}>
        <View style={styles.modelFields}>
          <SegmentedControl
            options={sourceOptions}
            value={modelSource}
            onValueChange={handleSource}
            size={SIZE}
            testID="automation-step-model-source"
          />
          {modelSource === "default" ? (
            <Text style={styles.hint}>
              {t("automationEditor.inspector.usesDefault", { model: defaultLabel })}
            </Text>
          ) : (
            <ModelFields
              serverId={state.selectedServerId}
              state={state}
              providers={providers}
              value={effectiveStepModel(step, state.defaults)}
              onModel={handleStepModel}
              onThinking={handleStepThinking}
              onMode={handleStepMode}
              testIDPrefix="automation-step"
            />
          )}
        </View>
      </Field>
      <Field
        label={t("automationEditor.inspector.workspace")}
        hint={
          state.projectIsGit === false
            ? t("automationEditor.inspector.worktreeNeedsGit")
            : undefined
        }
      >
        <SegmentedControl
          options={workspaceOptions}
          value={state.projectIsGit === false ? "project" : step.workspace}
          onValueChange={handleWorkspace}
          size={SIZE}
          testID="automation-workspace"
        />
      </Field>
      <LinksSection model={model} state={state} step={step} />
      <Button
        variant="ghost"
        leftIcon={Trash2}
        onPress={handleDelete}
        testID="automation-delete-step"
      >
        {t("automationEditor.inspector.deleteStep")}
      </Button>
    </>
  );
}

function CheckStepSection({
  model,
  state,
  step,
  runView,
}: {
  model: AutomationEditorModel;
  state: AutomationEditorState;
  step: EditorCheckStep;
  runView: InspectorRunView | null;
}): ReactElement {
  const { t } = useTranslation();
  // The uncontrolled value and custom-input fields restart when a preset rewrites them.
  const [fieldsKey, setFieldsKey] = useState(0);
  const sources = useCheckSources(state, step.id);
  const sourceKnown = sources.some((source) => source.ref === step.input);
  const [customOpen, setCustomOpen] = useState(!sourceKnown && step.input.trim() !== "");
  const showCustom = customOpen || (!sourceKnown && step.input.trim() !== "");
  const sourceOptions = useMemo<SelectFieldOption<string>[]>(
    () => [
      ...sources.map((source) => ({
        id: source.ref,
        value: source.ref,
        label: source.label,
        testID: `automation-condition-source-${source.ref}`,
      })),
      {
        id: CUSTOM_SOURCE,
        value: CUSTOM_SOURCE,
        label: t("automationEditor.inspector.sourceCustom"),
        testID: "automation-condition-source-custom",
      },
    ],
    [sources, t],
  );
  const sourceDisplay = useMemo<SelectFieldDisplay>(
    () => ({
      label: showCustom
        ? t("automationEditor.inspector.sourceCustom")
        : (sources.find((source) => source.ref === step.input)?.label ?? ""),
    }),
    [showCustom, sources, step.input, t],
  );
  const operatorOptions = useMemo<SelectFieldOption<AutomationConditionOperator>[]>(
    () =>
      CHECK_OPERATORS.map((operator) => ({
        id: operator,
        value: operator,
        label: t(`automationEditor.operators.${operator}`),
        testID: `automation-condition-operator-${operator}`,
      })),
    [t],
  );
  const operatorDisplay = useMemo<SelectFieldDisplay>(
    () => ({ label: t(`automationEditor.operators.${step.operator}`) }),
    [step.operator, t],
  );
  const handleTitle = useCallback(
    (title: string) => model.updateCheckStep(step.id, { title }),
    [model, step.id],
  );
  const handleInput = useCallback(
    (input: string) => model.updateCheckStep(step.id, { input }),
    [model, step.id],
  );
  const handleSource = useCallback(
    (ref: string) => {
      if (ref === CUSTOM_SOURCE) {
        setCustomOpen(true);
        return;
      }
      setCustomOpen(false);
      model.updateCheckStep(step.id, { input: ref });
    },
    [model, step.id],
  );
  const handleOperator = useCallback(
    (operator: AutomationConditionOperator) => model.updateCheckStep(step.id, { operator }),
    [model, step.id],
  );
  const handleValue = useCallback(
    (value: string) => model.updateCheckStep(step.id, { value }),
    [model, step.id],
  );
  const handlePreset = useCallback(
    async (preset: CheckPreset) => {
      const input = preset.input ?? (sourceKnown ? step.input : (sources[0]?.ref ?? step.input));
      model.updateCheckStep(step.id, {
        input,
        operator: preset.operator,
        value: preset.value,
      });
      setCustomOpen(false);
      setFieldsKey((key) => key + 1);
      const sourceStep = state.steps.find(
        (candidate): candidate is EditorAgentStep =>
          candidate.kind === "agent" && candidate.id === sourceStepId(input),
      );
      if (!preset.promptLine || !sourceStep) return;
      const line = t(`automationEditor.inspector.${preset.promptLine}`);
      if (sourceStep.prompt.includes(line)) return;
      const confirmed = await confirmDialog({
        title: t("automationEditor.inspector.appendTitle"),
        message: t("automationEditor.inspector.appendMessage", {
          line,
          title: sourceStep.title || sourceStep.id,
        }),
        confirmLabel: t("automationEditor.inspector.appendConfirm"),
        cancelLabel: t("automationEditor.inspector.appendSkip"),
      });
      if (confirmed) {
        const prompt = sourceStep.prompt.trimEnd();
        model.updateAgentStep(sourceStep.id, {
          prompt: prompt ? `${prompt}\n\n${line}` : line,
        });
      }
    },
    [model, sourceKnown, sources, state.steps, step.id, step.input, t],
  );
  const handleDelete = useCallback(() => model.removeStep(step.id), [model, step.id]);
  const needsValue = conditionOperatorNeedsValue(step.operator);
  const sourceText = useMemo(() => {
    const known = sources.find((source) => source.ref === step.input);
    return known?.phrase ?? step.input;
  }, [sources, step.input]);
  const summary = needsValue
    ? t("automationEditor.inspector.summary", {
        source: sourceText,
        operator: t(`automationEditor.operators.${step.operator}`),
        value: step.value.trim(),
      })
    : t("automationEditor.inspector.summaryNoValue", {
        source: sourceText,
        operator: t(`automationEditor.operators.${step.operator}`),
      });
  return (
    <>
      <SectionTitle icon={Split}>{t("automationEditor.inspector.checkTitle")}</SectionTitle>
      <ProblemList problems={state.problemsByTarget.get(step.id)} />
      <RunStepPanel stepId={step.id} runView={runView} />
      <Field label={t("automationEditor.inspector.name")}>
        <FormTextInput
          size={SIZE}
          testID="automation-step-title-input"
          accessibilityLabel={t("automationEditor.inspector.name")}
          initialValue={step.title}
          onChangeText={handleTitle}
          autoCorrect={false}
        />
      </Field>
      <PresetMenu pullRequest={state.triggerKind === "pull_request"} onPick={handlePreset} />
      <Text style={styles.sentenceLabel}>{t("automationEditor.inspector.checkWhen")}</Text>
      <SelectField
        label={t("automationEditor.inspector.checkInput")}
        value={showCustom ? CUSTOM_SOURCE : step.input}
        selectedDisplay={sourceDisplay}
        options={sourceOptions}
        onChange={handleSource}
        placeholder={t("automationEditor.inspector.checkInput")}
        emptyText={t("automationEditor.inspector.checkInput")}
        searchable={false}
        title={t("automationEditor.inspector.checkInput")}
        size={SIZE}
        triggerTestID="automation-condition-source"
      />
      {showCustom ? (
        <Field
          label={t("automationEditor.inspector.sourceCustom")}
          hint={t("automationEditor.inspector.checkInputHint")}
        >
          <FormTextInput
            key={`input-${fieldsKey}`}
            size={SIZE}
            testID="automation-condition-input"
            accessibilityLabel={t("automationEditor.inspector.checkInput")}
            initialValue={step.input}
            onChangeText={handleInput}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </Field>
      ) : null}
      <SelectField
        label={t("automationEditor.inspector.operator")}
        value={step.operator}
        selectedDisplay={operatorDisplay}
        options={operatorOptions}
        onChange={handleOperator}
        placeholder={t("automationEditor.inspector.operator")}
        emptyText={t("automationEditor.inspector.operator")}
        searchable={false}
        title={t("automationEditor.inspector.operator")}
        size={SIZE}
        triggerTestID="automation-condition-operator"
      />
      {needsValue ? (
        <Field
          label={t("automationEditor.inspector.value")}
          hint={step.operator === "matches" ? undefined : t("automationEditor.inspector.valueHint")}
        >
          <FormTextInput
            key={`value-${fieldsKey}`}
            size={SIZE}
            testID="automation-condition-value"
            accessibilityLabel={t("automationEditor.inspector.value")}
            initialValue={step.value}
            onChangeText={handleValue}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </Field>
      ) : null}
      <Text style={styles.hint} testID="automation-condition-summary">
        {summary}
      </Text>
      <TryCheck step={step} runView={runView} />
      <LinksSection model={model} state={state} step={step} />
      <Button
        variant="ghost"
        leftIcon={Trash2}
        onPress={handleDelete}
        testID="automation-delete-step"
      >
        {t("automationEditor.inspector.deleteStep")}
      </Button>
    </>
  );
}

interface CheckSource {
  ref: string;
  label: string;
  /** How the summary sentence names the source. */
  phrase: string;
}

/** What a check can read: the reply of each step before it, and a pull request's fields. */
function useCheckSources(state: AutomationEditorState, stepId: string): CheckSource[] {
  const { t } = useTranslation();
  return useMemo(() => {
    const sources = upstreamAgentSteps(state, stepId).map((step) => {
      const title = step.title || step.id;
      return {
        ref: stepOutputReference(step.id),
        label: t("automationEditor.inspector.sourceReply", { title }),
        phrase: t("automationEditor.inspector.replyOf", { title }),
      };
    });
    if (state.triggerKind === "pull_request") {
      for (const field of PULL_REQUEST_TEMPLATE_FIELDS) {
        const label = t("automationEditor.inspector.prField", { field });
        sources.push({ ref: `{{trigger.${field}}}`, label, phrase: label });
      }
    }
    return sources;
  }, [state, stepId, t]);
}

function PresetMenu({
  pullRequest,
  onPick,
}: {
  pullRequest: boolean;
  onPick: (preset: CheckPreset) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.presetRow}>
      <DropdownMenu>
        <DropdownTrigger
          accessibilityRole="button"
          accessibilityLabel={t("automationEditor.inspector.presetTitle")}
          testID="automation-condition-presets"
        >
          {t("automationEditor.inspector.presetTitle")}
        </DropdownTrigger>
        <DropdownMenuContent
          align="start"
          width={280}
          sheetTitle={t("automationEditor.inspector.presetTitle")}
        >
          {CHECK_PRESETS.filter((preset) => pullRequest || !preset.pullRequestOnly).map(
            (preset) => (
              <PresetItem key={preset.id} preset={preset} onPick={onPick} />
            ),
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

function PresetItem({
  preset,
  onPick,
}: {
  preset: CheckPreset;
  onPick: (preset: CheckPreset) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => onPick(preset), [onPick, preset]);
  return (
    <DropdownMenuItem onSelect={handleSelect} testID={`automation-condition-preset-${preset.id}`}>
      {t(`automationEditor.inspector.preset${preset.id[0].toUpperCase()}${preset.id.slice(1)}`)}
    </DropdownMenuItem>
  );
}

/** A sample reply and which way this check sends it, using the same test the daemon runs. */
function TryCheck({
  step,
  runView,
}: {
  step: EditorCheckStep;
  runView: InspectorRunView | null;
}): ReactElement {
  const { t } = useTranslation();
  const sourceId = sourceStepId(step.input);
  const runOutput =
    runView?.run.steps.find((candidate) => candidate.nodeId === sourceId)?.output ?? "";
  const [sample, setSample] = useState(runOutput);
  const edited = useRef(false);
  useEffect(() => {
    if (!edited.current) setSample(runOutput);
  }, [runOutput]);
  const handleSample = useCallback((text: string) => {
    edited.current = true;
    setSample(text);
  }, []);
  const verdict = useMemo<boolean | null>(() => {
    if (!sample.trim()) return null;
    if (conditionOperatorNeedsValue(step.operator) && !step.value.trim()) return null;
    try {
      return evaluateAutomationCondition(
        {
          id: step.id,
          kind: "condition",
          title: step.title,
          input: step.input,
          operator: step.operator,
          value: step.value,
        },
        sample,
      );
    } catch {
      return null;
    }
  }, [sample, step]);
  return (
    <Field
      label={t("automationEditor.inspector.tryTitle")}
      hint={t("automationEditor.inspector.tryHint")}
    >
      <FormTextInput
        key={`${sourceId ?? ""}:${runOutput}`}
        size={SIZE}
        testID="automation-condition-try-input"
        accessibilityLabel={t("automationEditor.inspector.tryTitle")}
        placeholder={t("automationEditor.inspector.tryPlaceholder")}
        initialValue={sample}
        onChangeText={handleSample}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
      />
      {verdict === null ? null : (
        <Text
          style={verdict ? styles.verdictYes : styles.verdictNo}
          testID="automation-condition-try-result"
        >
          {verdict ? t("automationEditor.nodes.yes") : t("automationEditor.nodes.no")}
        </Text>
      )}
    </Field>
  );
}

/** What runs after a step, with "Connect to…" so links can be made without dragging. */
function LinksSection({
  model,
  state,
  step,
}: {
  model: AutomationEditorModel;
  state: AutomationEditorState;
  step: EditorStep;
}): ReactElement {
  const { t } = useTranslation();
  const branches: (AutomationEdgeBranch | undefined)[] =
    step.kind === "condition" ? ["true", "false"] : [undefined];
  const [refusal, setRefusal] = useState<string | null>(null);
  useEffect(() => setRefusal(null), [state.edges]);
  const handleConnect = useCallback(
    (from: string, to: string, branch: AutomationEdgeBranch | undefined) => {
      const refused = model.connect(from, to, branch);
      // The edges change on success, which clears the message.
      if (refused) setRefusal(t(`automationEditor.linkRefused.${refused}`));
    },
    [model, t],
  );
  return (
    <View style={styles.links}>
      {branches.map((branch) => {
        const outgoing = state.edges.filter(
          (edge) => edge.from === step.id && edge.branch === branch,
        );
        const targets = connectableTargets(state, step.id, branch);
        let label = t("automationEditor.inspector.next");
        if (branch === "true") label = t("automationEditor.inspector.nextYes");
        if (branch === "false") label = t("automationEditor.inspector.nextNo");
        return (
          <Field key={branch ?? "always"} label={label}>
            <View style={styles.linkList}>
              {outgoing.length === 0 ? (
                <Text style={styles.hint}>{t("automationEditor.inspector.nothingNext")}</Text>
              ) : null}
              {outgoing.map((edge) => (
                <LinkRow
                  key={`${edge.to}:${edge.branch ?? ""}`}
                  edge={edge}
                  title={
                    state.steps.find((candidate) => candidate.id === edge.to)?.title || edge.to
                  }
                  onRemove={model.disconnect}
                />
              ))}
              <DropdownMenu>
                <DropdownTrigger
                  leading={connectLeading}
                  accessibilityRole="button"
                  accessibilityLabel={t("automationEditor.nodes.connectTo")}
                  disabled={targets.length === 0}
                  testID={`automation-connect-trigger-${branch ?? "always"}`}
                >
                  {t("automationEditor.nodes.connectTo")}
                </DropdownTrigger>
                <DropdownMenuContent
                  align="start"
                  width={240}
                  sheetTitle={t("automationEditor.nodes.connectTo")}
                >
                  <DropdownMenuLabel>{label}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {targets.map((target) => (
                    <ConnectItem
                      key={target.id}
                      from={step.id}
                      to={target.id}
                      branch={branch}
                      label={target.title || target.id}
                      onConnect={handleConnect}
                    />
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </View>
          </Field>
        );
      })}
      {refusal ? <Text style={styles.problemText}>{refusal}</Text> : null}
    </View>
  );
}

function LinkRow({
  edge,
  title,
  onRemove,
}: {
  edge: AutomationEdge;
  title: string;
  onRemove: (edge: AutomationEdge) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleRemove = useCallback(() => onRemove(edge), [edge, onRemove]);
  return (
    <View style={styles.linkRow}>
      <Text style={styles.linkTitle} numberOfLines={1}>
        {title}
      </Text>
      <Button
        size="sm"
        variant="ghost"
        onPress={handleRemove}
        testID={`automation-unlink-${edge.from}-${edge.to}`}
      >
        {t("automationEditor.nodes.removeLink")}
      </Button>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Run results
// ---------------------------------------------------------------------------

function RunStepPanel({
  stepId,
  runView,
}: {
  stepId: string;
  runView: InspectorRunView | null;
}): ReactElement | null {
  const { t } = useTranslation();
  const runStep = runView?.run.steps.find((candidate) => candidate.nodeId === stepId) ?? null;
  if (!runView || !runStep) {
    return null;
  }
  const failed = runStep.status === "failed" || runStep.status === "cancelled";
  return (
    <View style={styles.runPanel} testID="automation-run-step">
      <Text style={styles.runStatus}>
        {t("automationEditor.runs.stepIn", {
          status: t(`automationEditor.runs.stepStatus.${runStep.status}`),
        })}
      </Text>
      {runStep.reusedFrom ? (
        <Text style={styles.hint}>{t("automationEditor.runs.reused")}</Text>
      ) : null}
      {runStep.error ? (
        <Text style={styles.problemText} selectable>
          {runStep.error}
        </Text>
      ) : null}
      {runStep.output ? (
        <ScrollView style={styles.outputBox} nestedScrollEnabled>
          <Text style={styles.outputText} selectable testID="automation-run-step-output">
            {runStep.output}
          </Text>
        </ScrollView>
      ) : (
        <Text style={styles.hint}>{t("automationEditor.runs.noOutput")}</Text>
      )}
      {failed && runView.onRetry ? (
        <Button
          size="sm"
          variant="outline"
          leftIcon={RotateCcw}
          loading={runView.retrying}
          onPress={runView.onRetry}
          testID="automation-retry-from-here"
        >
          {t("automationEditor.runs.retryFromHere")}
        </Button>
      ) : null}
      {runView.retryError ? <Text style={styles.problemText}>{runView.retryError}</Text> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Option rows
// ---------------------------------------------------------------------------

const NO_PROFILE_VALUE = "__none__";

// Profiles live on a host. A stored or template profile the host does not have is dropped.
function ProfileField({
  serverId,
  value,
  onChange,
}: {
  serverId: string | null;
  value: string;
  onChange: (profileId: string) => void;
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
      size={SIZE}
      triggerTestID="automation-profile-trigger"
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
  const leadingSlot = useMemo(() => <Folder size={16} color={styles.mutedIcon.color} />, []);
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
  const leadingSlot = useMemo(() => <Brain size={16} color={styles.mutedIcon.color} />, []);
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
  return <Icon size={16} color={styles.mutedIcon.color} />;
}

const styles = StyleSheet.create((theme) => ({
  scroll: {
    flex: 1,
  },
  content: {
    padding: theme.spacing[4],
    gap: theme.spacing[4],
  },
  sectionTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: "600",
  },
  mutedIcon: {
    color: theme.colors.foregroundMuted,
  },
  sentenceLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  presetRow: {
    flexDirection: "row",
  },
  verdictYes: {
    color: theme.colors.success,
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
  },
  verdictNo: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  problems: {
    gap: theme.spacing[1],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.statusDanger,
  },
  problemRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  problemText: {
    flexShrink: 1,
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
  multiline: {
    minHeight: 140,
  },
  modelFields: {
    gap: theme.spacing[3],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  intervalInput: {
    width: 88,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  links: {
    gap: theme.spacing[3],
  },
  linkList: {
    gap: theme.spacing[1],
    alignItems: "flex-start",
  },
  linkRow: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "stretch",
    gap: theme.spacing[2],
  },
  linkTitle: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  runPanel: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  runStatus: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: "500",
  },
  outputBox: {
    maxHeight: 220,
  },
  outputText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
}));
