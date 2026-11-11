import type {
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
  ProviderSnapshotEntry,
} from "@pimi/protocol/agent-types";
import type {
  Automation,
  AutomationAgentNode,
  AutomationConditionOperator,
  AutomationDefinition,
  AutomationEdge,
  AutomationEdgeBranch,
  AutomationFlow,
  AutomationNode,
  AutomationTrigger,
  PullRequestEvent,
} from "@pimi/protocol/automation/types";
import {
  MAX_AUTOMATION_NODES,
  stepOutputReference,
  upstreamNodeIds,
  validateAutomationDefinition,
} from "@pimi/protocol/automation/validate";
import type { Cadence } from "@pimi/protocol/schedule/cadence";
import type { FormPreferences } from "@/create-agent-preferences/preferences";
import { formatThinkingOptionLabel } from "@/agent-controls/labels";
import {
  buildSelectableProviderSelectorProviders,
  type ProviderSelectorProvider,
} from "@/provider-selection/provider-selection";
import { filterSelectableModels, findModelByReference } from "@/provider-selection/model-catalog";
import {
  buildProviderDefinitionMapForStatuses,
  INITIAL_USER_MODIFIED,
  RESOLVABLE_PROVIDER_STATUSES,
  resolveDefaultModelId,
  resolveFormStateFromProviderModels,
  resolveThinkingOptionId,
  type FormInitialValues,
  type FormState,
  type ProviderModelsByProvider,
  type UserModifiedFields,
} from "@/provider-selection/resolve-agent-form";
import { buildProviderDefinitions } from "@/utils/provider-definitions";
import { shortenPath } from "@/utils/shorten-path";
import type { AutomationTemplate } from "./automation-templates";
import { normalizeAutomationFormCadence } from "./cadence-options";
import { PROJECT_OPTION_PREFIX, type AutomationProjectTarget } from "./automation-project-targets";

export interface AutomationFormDisplay {
  label: string;
  description?: string;
}

export interface AutomationFormHost {
  serverId: string;
  label: string;
}

export interface AutomationFormSnapshot {
  mode: "create" | "edit";
  automation?: Automation & { serverId?: string; serverName?: string };
  hosts: readonly AutomationFormHost[];
  defaults: {
    serverId?: string | null;
    projectTargets: readonly AutomationProjectTarget[];
    preferences?: FormPreferences;
    timezone?: string;
    template?: AutomationTemplate;
    /** A definition compiled from prose; the form opens on it in create mode. */
    draft?: AutomationDefinition;
  };
}

export interface AutomationFormAgentStep {
  id: string;
  kind: "agent";
  title: string;
  prompt: string;
  provider: AgentProvider | null;
  model: string;
  modeId: string;
  thinkingOptionId: string;
  profileId: string;
  featureValues?: AutomationAgentNode["featureValues"];
}

export interface AutomationFormConditionStep {
  id: string;
  kind: "condition";
  title: string;
  input: string;
  operator: AutomationConditionOperator;
  value: string;
}

export type AutomationFormStep = AutomationFormAgentStep | AutomationFormConditionStep;

export interface AutomationFormProviderSnapshot {
  entries: ProviderSnapshotEntry[];
}

export interface AutomationDisclosureState {
  showProjectField: boolean;
  showModelField: boolean;
  showThinkingField: boolean;
  showModeField: boolean;
  showIsolationField: boolean;
}

export interface AutomationProviderSnapshotRequest {
  serverId: string;
  cwd: string;
}

export interface AutomationFormProjectOption {
  id: string;
  value: string;
  label: string;
  testID: string;
}

export type AutomationFormTriggerKind = "schedule" | "manual" | "pull_request";
type CronCadence = Extract<Cadence, { type: "cron" }>;
type ProviderResolutionStatus = "idle" | "pending" | "complete";

// The step graph. The prompt, model, mode, thinking and profile fields below belong to the agent
// step `agentStepId`, and every publish copies them into `steps`. `selectedStepId` is the step the
// editor shows, which may be a condition.
export interface AutomationFormState {
  mode: "create" | "edit";
  triggerKind: AutomationFormTriggerKind;
  name: string;
  steps: AutomationFormStep[];
  edges: AutomationEdge[];
  selectedStepId: string;
  agentStepId: string;
  flowError: string | null;
  prRepo: string;
  prEvents: PullRequestEvent[];
  prompt: string;
  selectedProfileId: string;
  maxRuns: string;
  cadence: Cadence;
  submitCadence: CronCadence | undefined;
  hosts: AutomationFormHost[];
  projectOptions: AutomationFormProjectOption[];
  selectedServerId: string | null;
  selectedProvider: AgentProvider | null;
  selectedModel: string;
  selectedMode: string;
  selectedThinkingOptionId: string;
  workingDir: string;
  projectDisplay: AutomationFormDisplay | null;
  selectedProjectOptionId: string;
  selectedModelDisplay: AutomationFormDisplay | null;
  selectedModeDisplay: AutomationFormDisplay;
  selectedThinkingDisplay: AutomationFormDisplay | null;
  modelSelectorProviders: ProviderSelectorProvider[];
  modeOptions: AgentMode[];
  availableThinkingOptions: NonNullable<AgentModelDefinition["thinkingOptions"]>;
  isolation: "local" | "worktree";
  effectiveIsolation: "local" | "worktree";
  submitIsolation: "local" | "worktree" | undefined;
  canUseWorktreeIsolation: boolean;
  providerResolutionByServerId: Record<string, ProviderResolutionStatus>;
  providerSnapshotRequest: AutomationProviderSnapshotRequest | null;
  disclosure: AutomationDisclosureState;
  canSubmit: boolean;
  submitError: string | null;
}

export interface AutomationFormModel {
  getState: () => AutomationFormState;
  subscribe: (listener: () => void) => () => void;
  close: () => void;
  applyHosts: (hosts: readonly AutomationFormHost[]) => void;
  applyProjectTargets: (targets: readonly AutomationProjectTarget[]) => void;
  applyPreferences: (preferences: FormPreferences | undefined) => void;
  applyProviderSnapshot: (serverId: string, snapshot: AutomationFormProviderSnapshot) => void;
  setHost: (serverId: string | null) => void;
  setProject: (optionId: string, display: AutomationFormDisplay) => void;
  setModel: (provider: AgentProvider, modelId: string) => void;
  setThinking: (thinkingOptionId: string) => void;
  setSessionMode: (modeId: string) => void;
  setName: (value: string) => void;
  setPrompt: (value: string) => void;
  setProfile: (profileId: string) => void;
  selectStep: (stepId: string) => void;
  addStep: (kind: "agent" | "condition") => void;
  removeStep: (stepId: string) => void;
  /** Returns why the link was refused, or null. */
  connectSteps: (from: string, to: string, branch?: AutomationEdgeBranch) => string | null;
  disconnectSteps: (edge: AutomationEdge) => void;
  setStepTitle: (value: string) => void;
  setCondition: (
    patch: Partial<Pick<AutomationFormConditionStep, "input" | "operator" | "value">>,
  ) => void;
  setPrRepo: (value: string) => void;
  togglePrEvent: (event: PullRequestEvent) => void;
  setMaxRuns: (value: string) => void;
  setCadence: (value: Cadence) => void;
  setTriggerKind: (value: AutomationFormTriggerKind) => void;
  setIsolation: (value: "local" | "worktree") => void;
  setSubmitError: (value: string | null) => void;
}

const DEFAULT_CADENCE: Cadence = { type: "every", everyMs: 60 * 60 * 1000 };
const DEFAULT_TIMEZONE = "UTC";
export const UNATTENDED_MODE_LABEL = "Unattended (default)";

type ThinkingOption = NonNullable<AgentModelDefinition["thinkingOptions"]>[number];

// The stored automation being edited, or the compiled draft a new one starts from.
type AutomationFormSource = Pick<AutomationDefinition, "name" | "project" | "trigger" | "flow"> & {
  limits?: AutomationDefinition["limits"];
};

function formSource(snapshot: AutomationFormSnapshot): AutomationFormSource | undefined {
  return snapshot.automation ?? snapshot.defaults.draft;
}

// The first agent step opens selected; this is what the form reads back from it.
interface AgentStepConfig {
  cwd: string;
  provider: AutomationAgentNode["provider"];
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  isolation: "local" | "worktree";
}

function newAgentConfig(source: AutomationFormSource | undefined): AgentStepConfig | null {
  const node = source?.flow.nodes.find((candidate) => candidate.kind === "agent");
  if (!source || node?.kind !== "agent") {
    return null;
  }
  return {
    cwd: source.project.cwd,
    provider: node.provider,
    model: node.model,
    modeId: node.modeId,
    thinkingOptionId: node.thinkingOptionId,
    isolation: node.workspace === "worktree" ? "worktree" : "local",
  };
}

function toFormSteps(snapshot: AutomationFormSnapshot): AutomationFormStep[] {
  const source = formSource(snapshot);
  if (!source) {
    const template = snapshot.mode === "create" ? snapshot.defaults.template : undefined;
    return [
      {
        id: "agent",
        kind: "agent",
        title: "Agent",
        prompt: template?.prompt ?? "",
        provider: null,
        model: "",
        modeId: "",
        thinkingOptionId: "",
        profileId: template?.profileId ?? "",
      },
    ];
  }
  return source.flow.nodes.map(toFormStep);
}

function toFormStep(node: AutomationNode): AutomationFormStep {
  if (node.kind === "condition") {
    return node;
  }
  const step: AutomationFormAgentStep = {
    id: node.id,
    kind: "agent",
    title: node.title,
    prompt: node.prompt,
    provider: node.provider,
    model: node.model ?? "",
    modeId: node.modeId ?? "",
    thinkingOptionId: node.thinkingOptionId ?? "",
    profileId: node.profileId ?? "",
  };
  if (node.featureValues) {
    step.featureValues = node.featureValues;
  }
  return step;
}

function nextStepId(steps: readonly AutomationFormStep[], prefix: string): string {
  const ids = new Set(steps.map((step) => step.id));
  let index = steps.length + 1;
  while (ids.has(`${prefix}${index}`)) {
    index += 1;
  }
  return `${prefix}${index}`;
}

// Every agent step shares the automation's isolation; the editor has one isolation field.
export function buildAutomationFormFlow(
  state: Pick<AutomationFormState, "steps" | "edges">,
  workspace: "project" | "worktree",
): AutomationFlow {
  return {
    nodes: state.steps.map((step) => {
      if (step.kind === "condition") {
        return step;
      }
      if (!step.provider) {
        throw new Error(`Choose a model for step ${step.title || step.id}`);
      }
      const model = step.model.trim();
      const modeId = step.modeId.trim();
      const thinkingOptionId = step.thinkingOptionId.trim();
      return {
        id: step.id,
        kind: "agent",
        title: step.title.trim() || step.id,
        ...(step.profileId ? { profileId: step.profileId } : {}),
        provider: step.provider,
        ...(model ? { model } : {}),
        ...(modeId ? { modeId } : {}),
        ...(thinkingOptionId ? { thinkingOptionId } : {}),
        ...(step.featureValues ? { featureValues: step.featureValues } : {}),
        workspace,
        prompt: step.prompt.trim(),
      };
    }),
    edges: state.edges,
  };
}

export function buildAutomationFormTrigger(
  state: Pick<AutomationFormState, "triggerKind" | "submitCadence" | "prRepo" | "prEvents">,
  stored: AutomationTrigger | undefined,
): AutomationTrigger {
  if (state.triggerKind === "manual") {
    return { kind: "manual" };
  }
  if (state.triggerKind === "pull_request") {
    return { kind: "pull_request", repo: state.prRepo.trim(), events: state.prEvents };
  }
  if (state.submitCadence) {
    return { kind: "schedule", cadence: state.submitCadence };
  }
  // Editing without touching the cadence keeps the stored one.
  if (stored?.kind === "schedule") {
    return stored;
  }
  throw new Error("Choose a cadence before saving this automation");
}

// The graph and pull-request checks the daemon runs on save, shown while editing. Name, project
// and cadence have their own fields and checks.
function resolveFlowError(state: AutomationFormState): string | null {
  const missingModel = state.steps.find((step) => step.kind === "agent" && !step.provider);
  const flow = buildAutomationFormFlow(
    {
      steps: state.steps.map((step) =>
        step.kind === "agent" && !step.provider ? { ...step, provider: "claude" } : step,
      ),
      edges: state.edges,
    },
    "project",
  );
  const issues = validateAutomationDefinition({
    name: "draft",
    project: { cwd: "/" },
    trigger:
      state.triggerKind === "pull_request"
        ? { kind: "pull_request", repo: state.prRepo.trim(), events: state.prEvents }
        : { kind: "manual" },
    flow,
  });
  if (issues.length > 0) {
    return issues[0]?.message ?? "This automation is not valid";
  }
  if (missingModel && state.steps.length > 1) {
    return `Choose a model for step ${missingModel.title || missingModel.id}`;
  }
  return null;
}

function buildProjectOptionTestId(optionId: string): string {
  const targetKey = optionId.slice(PROJECT_OPTION_PREFIX.length).replace(/^[^:]+:/, "");
  return `automation-project-option-${targetKey}`;
}

function buildProjectDisplay(target: AutomationProjectTarget): AutomationFormDisplay {
  return { label: target.projectName };
}

function buildStoredProjectDisplay(cwd: string): AutomationFormDisplay | null {
  const storedPath = cwd.trim();
  if (!storedPath) {
    return null;
  }
  return { label: shortenPath(storedPath) };
}

function buildProjectOptions(
  targets: readonly AutomationProjectTarget[],
  serverId: string | null,
): AutomationFormProjectOption[] {
  if (!serverId) {
    return [];
  }
  return targets
    .filter((target) => target.serverId === serverId)
    .map((target) => ({
      id: target.optionId,
      value: target.optionId,
      label: target.projectName,
      testID: buildProjectOptionTestId(target.optionId),
    }));
}

function resolveProjectTarget(input: {
  targets: readonly AutomationProjectTarget[];
  serverId: string | null;
  cwd: string;
}): AutomationProjectTarget | null {
  const cwd = input.cwd.trim();
  if (!input.serverId || !cwd) {
    return null;
  }
  return (
    input.targets.find((target) => target.serverId === input.serverId && target.cwd === cwd) ?? null
  );
}

function findProjectTargetByOptionId(
  targets: readonly AutomationProjectTarget[],
  optionId: string,
): AutomationProjectTarget | null {
  return targets.find((target) => target.optionId === optionId) ?? null;
}

function resolveProjectDisplay(input: {
  targets: readonly AutomationProjectTarget[];
  serverId: string | null;
  cwd: string;
}): AutomationFormDisplay | null {
  const target = resolveProjectTarget(input);
  if (target) {
    return buildProjectDisplay(target);
  }
  return buildStoredProjectDisplay(input.cwd);
}

function buildProviderModelsByProvider(entries: ProviderSnapshotEntry[]): ProviderModelsByProvider {
  const map: ProviderModelsByProvider = new Map();
  for (const entry of entries) {
    map.set(entry.provider, filterSelectableModels(entry.models ?? null));
  }
  return map;
}

function resolveSelectedEntry(
  entries: readonly ProviderSnapshotEntry[],
  provider: AgentProvider | null,
): ProviderSnapshotEntry | null {
  if (!provider) {
    return null;
  }
  return entries.find((entry) => entry.provider === provider) ?? null;
}

function resolveModeOptions(
  entries: readonly ProviderSnapshotEntry[],
  provider: AgentProvider | null,
): AgentMode[] {
  return resolveSelectedEntry(entries, provider)?.modes ?? [];
}

function resolveAvailableModels(
  entries: readonly ProviderSnapshotEntry[],
  provider: AgentProvider | null,
): AgentModelDefinition[] | null {
  return filterSelectableModels(resolveSelectedEntry(entries, provider)?.models ?? null);
}

function resolveEffectiveModel(
  models: AgentModelDefinition[] | null,
  modelId: string,
): AgentModelDefinition | null {
  const selectedModelId = modelId.trim();
  if (!models || !selectedModelId) {
    return null;
  }
  return (
    models.find((model) => model.id === selectedModelId) ??
    models.find((model) => model.isDefault) ??
    models[0] ??
    null
  );
}

function resolveThinkingOptions(
  entries: readonly ProviderSnapshotEntry[],
  provider: AgentProvider | null,
  modelId: string,
): NonNullable<AgentModelDefinition["thinkingOptions"]> {
  const model = resolveEffectiveModel(resolveAvailableModels(entries, provider), modelId);
  return model?.thinkingOptions ?? [];
}

function resolveModelDisplay(input: {
  entries: readonly ProviderSnapshotEntry[];
  provider: AgentProvider | null;
  modelId: string;
}): AutomationFormDisplay | null {
  const modelId = input.modelId.trim();
  if (!modelId) {
    return null;
  }
  const model = resolveEffectiveModel(
    resolveAvailableModels(input.entries, input.provider),
    modelId,
  );
  return { label: model?.label ?? modelId };
}

function resolveModeDisplay(input: {
  modeOptions: readonly AgentMode[];
  modeId: string;
}): AutomationFormDisplay {
  const modeId = input.modeId.trim();
  if (!modeId) {
    return { label: UNATTENDED_MODE_LABEL };
  }
  return { label: input.modeOptions.find((mode) => mode.id === modeId)?.label ?? modeId };
}

function resolveThinkingDisplay(input: {
  options: readonly ThinkingOption[];
  thinkingOptionId: string;
}): AutomationFormDisplay | null {
  const thinkingOptionId = input.thinkingOptionId.trim();
  if (!thinkingOptionId) {
    return null;
  }
  const option = input.options.find((entry) => entry.id === thinkingOptionId) ?? {
    id: thinkingOptionId,
  };
  return { label: formatThinkingOptionLabel(option) };
}

function isSelectedModelValidForProviders(input: {
  providers: readonly ProviderSelectorProvider[];
  selectedProvider: AgentProvider | null;
  selectedModel: string;
}): boolean {
  if (!input.selectedProvider) {
    return false;
  }
  const provider = input.providers.find((entry) => entry.id === input.selectedProvider);
  if (!provider || provider.modelSelection.kind !== "models") {
    return false;
  }
  const selectedModel = input.selectedModel.trim();
  if (!selectedModel) {
    return true;
  }
  return provider.modelSelection.rows.some((row) => row.modelId === selectedModel);
}

function normalizeInitialValues(input: {
  snapshot: AutomationFormSnapshot;
}): FormInitialValues | undefined {
  const config = newAgentConfig(formSource(input.snapshot));
  if (!config) {
    return undefined;
  }
  return {
    provider: config.provider,
    model: config.model ?? null,
    modeId: config.modeId ?? null,
    thinkingOptionId: config.thinkingOptionId ?? null,
  };
}

function resolveInitialServerId(snapshot: AutomationFormSnapshot): string | null {
  if (snapshot.mode === "edit") {
    return snapshot.automation?.serverId ?? snapshot.defaults.serverId ?? null;
  }
  if (snapshot.defaults.serverId !== undefined) {
    return snapshot.defaults.serverId;
  }
  if (snapshot.hosts.length === 1) {
    return snapshot.hosts[0]?.serverId ?? null;
  }
  return null;
}

function makeProviderResolutionRecord(
  serverId: string | null,
): Record<string, ProviderResolutionStatus> {
  if (!serverId) {
    return {};
  }
  return { [serverId]: "pending" };
}

function buildProviderSnapshotRequest(input: {
  selectedServerId: string | null;
  workingDir: string;
}): AutomationProviderSnapshotRequest | null {
  if (!input.selectedServerId || !input.workingDir.trim()) {
    return null;
  }
  return { serverId: input.selectedServerId, cwd: input.workingDir };
}

function buildInitialProjectDisplay(input: {
  config: ReturnType<typeof newAgentConfig>;
  targets: readonly AutomationProjectTarget[];
  selectedServerId: string | null;
}): AutomationFormDisplay | null {
  if (!input.config) {
    return null;
  }
  return resolveProjectDisplay({
    targets: input.targets,
    serverId: input.selectedServerId,
    cwd: input.config.cwd,
  });
}

function buildInitialModelDisplay(modelId: string): AutomationFormDisplay | null {
  if (!modelId) {
    return null;
  }
  return { label: modelId };
}

function buildInitialModeDisplay(modeId: string): AutomationFormDisplay {
  if (!modeId) {
    return { label: UNATTENDED_MODE_LABEL };
  }
  return { label: modeId };
}

function buildInitialThinkingDisplay(thinkingOptionId: string): AutomationFormDisplay | null {
  if (!thinkingOptionId) {
    return null;
  }
  return { label: formatThinkingOptionLabel({ id: thinkingOptionId }) };
}

function formatInitialMaxRuns(source: AutomationFormSource | undefined): string {
  if (source?.limits?.maxRuns == null) {
    return "";
  }
  return String(source.limits.maxRuns);
}

function resolveInitialIsolation(input: {
  config: ReturnType<typeof newAgentConfig>;
  preferences: FormPreferences | undefined;
}): "local" | "worktree" {
  if (input.config) {
    return input.config.isolation;
  }
  return input.preferences?.isolation ?? "local";
}

function resolveSelectedProjectOptionId(target: AutomationProjectTarget | null): string {
  return target?.optionId ?? "";
}

function buildInitialProviderResolution(
  request: AutomationProviderSnapshotRequest | null,
): Record<string, ProviderResolutionStatus> {
  if (!request) {
    return {};
  }
  return makeProviderResolutionRecord(request.serverId);
}

function resolveCanUseWorktreeIsolation(input: {
  state: Pick<AutomationFormState, "selectedServerId" | "workingDir">;
  targets: readonly AutomationProjectTarget[];
}): boolean {
  const target = resolveProjectTarget({
    targets: input.targets,
    serverId: input.state.selectedServerId,
    cwd: input.state.workingDir,
  });
  return Boolean(target?.isGit);
}

function resolveEffectiveIsolation(input: {
  isolation: "local" | "worktree";
  canUseWorktreeIsolation: boolean;
  selectedServerId: string | null;
  providerResolutionByServerId: Record<string, ProviderResolutionStatus>;
}): "local" | "worktree" {
  if (input.isolation !== "worktree") {
    return "local";
  }
  if (input.canUseWorktreeIsolation) {
    return "worktree";
  }
  if (
    !input.selectedServerId ||
    input.providerResolutionByServerId[input.selectedServerId] !== "complete"
  ) {
    return "worktree";
  }
  return "local";
}

function resolveDisclosure(state: AutomationFormState): AutomationDisclosureState {
  const hasProject = state.workingDir.trim().length > 0;
  const hasSelectedProvider = Boolean(state.selectedProvider);
  const hasSelectedModel = Boolean(state.selectedProvider && state.selectedModel.trim());
  const showProjectField = state.mode === "edit" || Boolean(state.selectedServerId);
  const showModelField = hasProject;
  return {
    showProjectField,
    showModelField,
    showThinkingField:
      showModelField && hasSelectedModel && state.availableThinkingOptions.length > 0,
    showModeField: showModelField && hasSelectedProvider && state.modeOptions.length > 0,
    showIsolationField: hasProject && state.canUseWorktreeIsolation,
  };
}

function resolveCanSubmit(state: AutomationFormState): boolean {
  if (state.name.trim().length === 0 || state.prompt.trim().length === 0) {
    return false;
  }
  if (state.flowError !== null) {
    return false;
  }
  if (state.steps.some((step) => step.kind === "agent" && !step.provider)) {
    return false;
  }
  if (state.triggerKind === "schedule" && state.submitCadence === undefined) {
    return false;
  }
  const hasWorkingDir = state.workingDir.trim().length > 0;
  const hasMatchedProject = state.selectedProjectOptionId.trim().length > 0;
  if (state.mode === "create" && !hasMatchedProject) {
    return false;
  }
  if (!hasWorkingDir) {
    return false;
  }
  return isSelectedModelValidForProviders({
    providers: state.modelSelectorProviders,
    selectedProvider: state.selectedProvider,
    selectedModel: state.selectedModel,
  });
}

function updateDerivedState(input: {
  state: AutomationFormState;
  hosts: readonly AutomationFormHost[];
  targets: readonly AutomationProjectTarget[];
  providerEntries: readonly ProviderSnapshotEntry[];
}): AutomationFormState {
  const modeOptions = resolveModeOptions(input.providerEntries, input.state.selectedProvider);
  const availableThinkingOptions = resolveThinkingOptions(
    input.providerEntries,
    input.state.selectedProvider,
    input.state.selectedModel,
  );
  const canUseWorktreeIsolation = resolveCanUseWorktreeIsolation({
    state: input.state,
    targets: input.targets,
  });
  const effectiveIsolation = resolveEffectiveIsolation({
    isolation: input.state.isolation,
    canUseWorktreeIsolation,
    selectedServerId: input.state.selectedServerId,
    providerResolutionByServerId: input.state.providerResolutionByServerId,
  });
  const projectTarget = resolveProjectTarget({
    targets: input.targets,
    serverId: input.state.selectedServerId,
    cwd: input.state.workingDir,
  });
  const steps = input.state.steps.map((step) =>
    step.id === input.state.agentStepId && step.kind === "agent"
      ? {
          ...step,
          prompt: input.state.prompt,
          provider: input.state.selectedProvider,
          model: input.state.selectedModel,
          modeId: input.state.selectedMode,
          thinkingOptionId: input.state.selectedThinkingOptionId,
          profileId: input.state.selectedProfileId,
        }
      : step,
  );
  const nextState: AutomationFormState = {
    ...input.state,
    steps,
    hosts: [...input.hosts],
    projectOptions: buildProjectOptions(input.targets, input.state.selectedServerId),
    projectDisplay: resolveProjectDisplay({
      targets: input.targets,
      serverId: input.state.selectedServerId,
      cwd: input.state.workingDir,
    }),
    selectedProjectOptionId: projectTarget?.optionId ?? input.state.selectedProjectOptionId,
    selectedModelDisplay: resolveModelDisplay({
      entries: input.providerEntries,
      provider: input.state.selectedProvider,
      modelId: input.state.selectedModel,
    }),
    selectedModeDisplay: resolveModeDisplay({ modeOptions, modeId: input.state.selectedMode }),
    selectedThinkingDisplay: resolveThinkingDisplay({
      options: availableThinkingOptions,
      thinkingOptionId: input.state.selectedThinkingOptionId,
    }),
    modeOptions,
    availableThinkingOptions,
    canUseWorktreeIsolation,
    effectiveIsolation,
    submitIsolation: effectiveIsolation,
  };
  const disclosure = resolveDisclosure(nextState);
  const flowError = resolveFlowError(nextState);
  return {
    ...nextState,
    disclosure,
    flowError,
    canSubmit: resolveCanSubmit({ ...nextState, disclosure, flowError }),
  };
}

function buildInitialDraft(snapshot: AutomationFormSnapshot) {
  const template = snapshot.mode === "create" ? snapshot.defaults.template : undefined;
  const source = formSource(snapshot);
  const trigger = source?.trigger;
  const storedCadence = trigger?.kind === "schedule" ? trigger.cadence : undefined;
  const cadence = normalizeAutomationFormCadence(
    storedCadence ?? template?.cadence ?? DEFAULT_CADENCE,
    snapshot.defaults.timezone ?? DEFAULT_TIMEZONE,
  );
  // A stored cadence stays as stored until the cadence field changes; a compiled draft's cron
  // and a template's cadence are submitted as shown.
  const keepsStoredCadence = Boolean(storedCadence && snapshot.automation);
  return {
    triggerKind: trigger?.kind ?? "schedule",
    name: source?.name ?? template?.name ?? "",
    ...buildInitialSteps(snapshot),
    ...buildInitialPullRequest(trigger),
    maxRuns: formatInitialMaxRuns(source),
    cadence,
    submitCadence: keepsStoredCadence ? undefined : cadence,
  };
}

function buildInitialSteps(snapshot: AutomationFormSnapshot) {
  const steps = toFormSteps(snapshot);
  const firstAgent = steps.find((step): step is AutomationFormAgentStep => step.kind === "agent");
  return {
    steps,
    edges: formSource(snapshot)?.flow.edges ?? [],
    selectedStepId: firstAgent?.id ?? "",
    agentStepId: firstAgent?.id ?? "",
    flowError: null,
    prompt: firstAgent?.prompt ?? "",
    selectedProfileId: firstAgent?.profileId ?? "",
  };
}

function buildInitialPullRequest(trigger: AutomationTrigger | undefined): {
  prRepo: string;
  prEvents: PullRequestEvent[];
} {
  if (trigger?.kind === "pull_request") {
    return { prRepo: trigger.repo, prEvents: trigger.events };
  }
  return { prRepo: "", prEvents: ["opened", "synchronize"] };
}

function buildInitialState(snapshot: AutomationFormSnapshot): AutomationFormState {
  const selectedServerId = resolveInitialServerId(snapshot);
  const config = newAgentConfig(formSource(snapshot));
  const workingDir = config?.cwd ?? "";
  const selectedProjectTarget = resolveProjectTarget({
    targets: snapshot.defaults.projectTargets,
    serverId: selectedServerId,
    cwd: workingDir,
  });
  const providerSnapshotRequest = buildProviderSnapshotRequest({
    selectedServerId,
    workingDir,
  });
  const initialModel = config?.model ?? "";
  const initialMode = config?.modeId ?? "";
  const initialThinking = config?.thinkingOptionId ?? "";
  const state: AutomationFormState = {
    mode: snapshot.mode,
    ...buildInitialDraft(snapshot),
    hosts: [...snapshot.hosts],
    projectOptions: buildProjectOptions(snapshot.defaults.projectTargets, selectedServerId),
    selectedServerId,
    selectedProvider: config?.provider ?? null,
    selectedModel: initialModel,
    selectedMode: initialMode,
    selectedThinkingOptionId: initialThinking,
    workingDir,
    projectDisplay: buildInitialProjectDisplay({
      config,
      targets: snapshot.defaults.projectTargets,
      selectedServerId,
    }),
    selectedProjectOptionId: resolveSelectedProjectOptionId(selectedProjectTarget),
    selectedModelDisplay: buildInitialModelDisplay(initialModel),
    selectedModeDisplay: buildInitialModeDisplay(initialMode),
    selectedThinkingDisplay: buildInitialThinkingDisplay(initialThinking),
    modelSelectorProviders: [],
    modeOptions: [],
    availableThinkingOptions: [],
    isolation: resolveInitialIsolation({ config, preferences: snapshot.defaults.preferences }),
    effectiveIsolation: "local",
    submitIsolation: undefined,
    canUseWorktreeIsolation: false,
    providerResolutionByServerId: buildInitialProviderResolution(providerSnapshotRequest),
    providerSnapshotRequest,
    disclosure: {
      showProjectField: false,
      showModelField: false,
      showThinkingField: false,
      showModeField: false,
      showIsolationField: false,
    },
    canSubmit: false,
    submitError: null,
  };
  return updateDerivedState({
    state,
    hosts: snapshot.hosts,
    targets: snapshot.defaults.projectTargets,
    providerEntries: [],
  });
}

function toFormState(state: AutomationFormState): FormState {
  return {
    provider: state.selectedProvider,
    modeId: state.selectedMode,
    model: state.selectedModel,
    thinkingOptionId: state.selectedThinkingOptionId,
  };
}

function applyResolvedFormState(state: AutomationFormState, form: FormState): AutomationFormState {
  return {
    ...state,
    selectedProvider: form.provider,
    selectedMode: form.modeId,
    selectedModel: form.model,
    selectedThinkingOptionId: form.thinkingOptionId,
  };
}

function resolveSnapshotSelection(input: {
  state: AutomationFormState;
  snapshot: AutomationFormSnapshot;
  initialValues: FormInitialValues | undefined;
  preferences: FormPreferences | null;
  providerEntries: ProviderSnapshotEntry[];
  userModified: UserModifiedFields;
}): AutomationFormState {
  const providerDefinitions = buildProviderDefinitions(input.providerEntries);
  const allowedProviderMap = buildProviderDefinitionMapForStatuses({
    snapshotEntries: input.providerEntries,
    providerDefinitions,
    statuses: RESOLVABLE_PROVIDER_STATUSES,
  });
  const resolved = resolveFormStateFromProviderModels(
    input.initialValues,
    input.preferences,
    buildProviderModelsByProvider(input.providerEntries),
    input.userModified,
    toFormState(input.state),
    allowedProviderMap,
  );
  // The shared resolver falls back to the provider's default chat mode. An automation leaves
  // the mode empty instead so its runs use the unattended mode.
  const modeId = input.userModified.modeId ? resolved.modeId : (input.initialValues?.modeId ?? "");
  return applyResolvedFormState(input.state, { ...resolved, modeId });
}

function preferencesForSnapshotResolution(
  snapshot: AutomationFormSnapshot,
  preferences: FormPreferences | null,
): FormPreferences | null {
  return snapshot.mode === "edit" ? null : preferences;
}

// An empty mode means the provider's unattended mode, which the daemon picks per run.
function pickModeForProvider(input: {
  provider: AgentProvider;
  currentProvider: AgentProvider | null;
  currentMode: string;
}): string {
  const currentMode = input.currentMode.trim();
  if (input.currentProvider === input.provider && currentMode) {
    return currentMode;
  }
  return "";
}

function pickModelForProvider(input: {
  entries: readonly ProviderSnapshotEntry[];
  provider: AgentProvider;
  modelId: string;
}): string {
  const normalizedModelId = input.modelId.trim();
  if (normalizedModelId) {
    return normalizedModelId;
  }
  return resolveDefaultModelId(resolveAvailableModels(input.entries, input.provider));
}

function thinkingDraftKey(provider: AgentProvider, modelId: string): string {
  return `${provider}:${modelId}`;
}

function seedThinkingDrafts(
  drafts: Map<string, string>,
  preferences: FormPreferences | null,
): void {
  for (const [provider, providerPreferences] of Object.entries(
    preferences?.providerPreferences ?? {},
  )) {
    for (const [modelId, thinkingOptionId] of Object.entries(
      providerPreferences?.thinkingByModel ?? {},
    )) {
      const key = thinkingDraftKey(provider as AgentProvider, modelId);
      if (!drafts.has(key)) {
        drafts.set(key, thinkingOptionId);
      }
    }
  }
}

function canonicalizeThinkingDrafts(
  drafts: Map<string, string>,
  entries: readonly ProviderSnapshotEntry[],
): void {
  for (const entry of entries) {
    const models = filterSelectableModels(entry.models ?? null);
    if (!models) {
      continue;
    }
    for (const model of models) {
      const canonicalKey = thinkingDraftKey(entry.provider, model.id);
      if (drafts.has(canonicalKey)) {
        continue;
      }
      const resolvedAlias = model.aliases?.find(
        (alias) =>
          findModelByReference(models, alias)?.id === model.id &&
          drafts.has(thinkingDraftKey(entry.provider, alias)),
      );
      if (!resolvedAlias) {
        continue;
      }
      const aliasedThinking = drafts.get(thinkingDraftKey(entry.provider, resolvedAlias));
      if (aliasedThinking !== undefined) {
        drafts.set(canonicalKey, aliasedThinking);
      }
    }
  }
}

export function openAutomationForm(snapshot: AutomationFormSnapshot): AutomationFormModel {
  const listeners = new Set<() => void>();
  const initialValues = normalizeInitialValues({
    snapshot,
  });
  let closed = false;
  let hosts = snapshot.hosts;
  let projectTargets = snapshot.defaults.projectTargets;
  let preferences = snapshot.defaults.preferences ?? null;
  const thinkingDrafts = new Map<string, string>();
  seedThinkingDrafts(thinkingDrafts, preferences);
  const initialAgentConfig = newAgentConfig(formSource(snapshot));
  if (
    initialAgentConfig?.provider &&
    initialAgentConfig.model &&
    initialAgentConfig.thinkingOptionId
  ) {
    thinkingDrafts.set(
      thinkingDraftKey(initialAgentConfig.provider, initialAgentConfig.model),
      initialAgentConfig.thinkingOptionId,
    );
  }
  let providerEntries: ProviderSnapshotEntry[] = [];
  let userModified = { ...INITIAL_USER_MODIFIED, isolation: false };
  const timezone = snapshot.defaults.timezone ?? DEFAULT_TIMEZONE;
  let state = buildInitialState(snapshot);

  function publish(nextState: AutomationFormState): void {
    if (closed) {
      return;
    }
    state = updateDerivedState({
      state: nextState,
      hosts,
      targets: projectTargets,
      providerEntries,
    });
    for (const listener of listeners) {
      listener();
    }
  }

  function requestProviderSnapshot(serverId: string | null, cwd: string): void {
    const trimmedCwd = cwd.trim();
    if (!serverId || !trimmedCwd) {
      publish({
        ...state,
        providerSnapshotRequest: null,
      });
      return;
    }
    publish({
      ...state,
      providerResolutionByServerId: {
        ...state.providerResolutionByServerId,
        [serverId]: "pending",
      },
      providerSnapshotRequest: { serverId, cwd: trimmedCwd },
    });
  }

  function clearProviderSelection(nextState: AutomationFormState): AutomationFormState {
    providerEntries = [];
    return {
      ...nextState,
      selectedProvider: null,
      selectedModel: "",
      selectedMode: "",
      selectedThinkingOptionId: "",
      modelSelectorProviders: [],
      modeOptions: [],
      availableThinkingOptions: [],
      selectedModelDisplay: null,
      selectedModeDisplay: { label: UNATTENDED_MODE_LABEL },
      selectedThinkingDisplay: null,
      providerSnapshotRequest: null,
    };
  }

  function resolvePreferences(nextState: AutomationFormState): AutomationFormState {
    let resolved = nextState;
    if (
      snapshot.mode === "create" &&
      !userModified.isolation &&
      preferences?.isolation !== undefined
    ) {
      resolved = { ...resolved, isolation: preferences.isolation };
    }
    if (providerEntries.length === 0) {
      return resolved;
    }
    return resolveSnapshotSelection({
      state: resolved,
      snapshot,
      initialValues,
      preferences: preferencesForSnapshotResolution(snapshot, preferences),
      providerEntries,
      userModified,
    });
  }

  return {
    getState: () => state,
    subscribe(listener) {
      if (closed) {
        return () => {};
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      closed = true;
      listeners.clear();
    },
    applyHosts(nextHosts) {
      if (closed || hosts === nextHosts) {
        return;
      }
      hosts = nextHosts;
      publish(state);
    },
    applyProjectTargets(nextTargets) {
      if (closed || projectTargets === nextTargets) {
        return;
      }
      projectTargets = nextTargets;
      publish(state);
    },
    applyPreferences(nextPreferences) {
      const normalizedPreferences = nextPreferences ?? null;
      if (closed || preferences === normalizedPreferences) {
        return;
      }
      preferences = normalizedPreferences;
      seedThinkingDrafts(thinkingDrafts, preferences);
      publish(resolvePreferences(state));
    },
    applyProviderSnapshot(serverId, providerSnapshot) {
      if (closed || state.selectedServerId !== serverId) {
        return;
      }
      providerEntries = providerSnapshot.entries;
      canonicalizeThinkingDrafts(thinkingDrafts, providerEntries);
      const isPendingResolution = state.providerSnapshotRequest?.serverId === serverId;
      const resolved = resolveSnapshotSelection({
        state,
        snapshot,
        initialValues,
        preferences: preferencesForSnapshotResolution(snapshot, preferences),
        providerEntries,
        userModified,
      });
      const providerResolutionByServerId: Record<string, ProviderResolutionStatus> = {
        ...state.providerResolutionByServerId,
      };
      if (isPendingResolution) {
        providerResolutionByServerId[serverId] = "complete";
      }
      publish({
        ...resolved,
        modelSelectorProviders: buildSelectableProviderSelectorProviders(providerEntries),
        providerResolutionByServerId,
        providerSnapshotRequest: isPendingResolution ? null : state.providerSnapshotRequest,
      });
    },
    setHost(serverId) {
      if (closed || state.selectedServerId === serverId) {
        return;
      }
      publish(
        clearProviderSelection({
          ...state,
          selectedServerId: serverId,
          workingDir: "",
          projectDisplay: null,
          selectedProjectOptionId: "",
          providerResolutionByServerId: {},
        }),
      );
    },
    setProject(optionId, display) {
      if (closed) {
        return;
      }
      const target = findProjectTargetByOptionId(projectTargets, optionId);
      if (!target) {
        return;
      }
      const providerScopeChanged =
        state.selectedServerId !== target.serverId || state.workingDir !== target.cwd;
      if (!providerScopeChanged && state.selectedProjectOptionId === target.optionId) {
        return;
      }
      const nextState = {
        ...state,
        selectedServerId: target.serverId,
        workingDir: target.cwd,
        projectDisplay: display,
        selectedProjectOptionId: target.optionId,
      };
      publish(providerScopeChanged ? clearProviderSelection(nextState) : nextState);
      if (!providerScopeChanged) {
        return;
      }
      requestProviderSnapshot(target.serverId, target.cwd);
    },
    setModel(provider, modelId) {
      if (closed) {
        return;
      }
      const selectedModel = pickModelForProvider({ entries: providerEntries, provider, modelId });
      const availableModels = resolveAvailableModels(providerEntries, provider);
      const selectedThinkingOptionId = resolveThinkingOptionId({
        availableModels,
        modelId: selectedModel,
        requestedThinkingOptionId:
          thinkingDrafts.get(thinkingDraftKey(provider, selectedModel)) ?? "",
      });
      if (selectedModel && selectedThinkingOptionId) {
        thinkingDrafts.set(thinkingDraftKey(provider, selectedModel), selectedThinkingOptionId);
      }
      userModified = {
        ...userModified,
        provider: true,
        model: true,
        modeId: true,
        thinkingOptionId: true,
      };
      publish({
        ...state,
        selectedProvider: provider,
        selectedModel,
        selectedMode: pickModeForProvider({
          provider,
          currentProvider: state.selectedProvider,
          currentMode: state.selectedMode,
        }),
        selectedThinkingOptionId,
      });
    },
    setThinking(thinkingOptionId) {
      if (closed) {
        return;
      }
      if (state.selectedProvider && state.selectedModel) {
        thinkingDrafts.set(
          thinkingDraftKey(state.selectedProvider, state.selectedModel),
          thinkingOptionId,
        );
      }
      userModified = { ...userModified, thinkingOptionId: true };
      publish({ ...state, selectedThinkingOptionId: thinkingOptionId });
    },
    setSessionMode(modeId) {
      if (closed) {
        return;
      }
      userModified = { ...userModified, modeId: true };
      publish({ ...state, selectedMode: modeId });
    },
    setName(value) {
      publish({ ...state, name: value });
    },
    setPrompt(value) {
      publish({ ...state, prompt: value });
    },
    setMaxRuns(value) {
      publish({ ...state, maxRuns: value });
    },
    setCadence(value) {
      const cadence = normalizeAutomationFormCadence(value, timezone);
      publish({ ...state, cadence, submitCadence: cadence });
    },
    setTriggerKind(value) {
      publish({ ...state, triggerKind: value });
    },
    setIsolation(value) {
      userModified = { ...userModified, isolation: true };
      publish({ ...state, isolation: value });
    },
    setProfile(profileId) {
      publish({ ...state, selectedProfileId: profileId });
    },
    selectStep(stepId) {
      const step = state.steps.find((candidate) => candidate.id === stepId);
      if (closed || !step || stepId === state.selectedStepId) {
        return;
      }
      if (step.kind === "condition" || stepId === state.agentStepId) {
        publish({ ...state, selectedStepId: stepId });
        return;
      }
      // The step's stored choices win over provider defaults from here on.
      if (step.provider) {
        userModified = {
          ...userModified,
          provider: true,
          model: true,
          modeId: true,
          thinkingOptionId: true,
        };
      }
      publish({
        ...state,
        selectedStepId: stepId,
        agentStepId: stepId,
        prompt: step.prompt,
        selectedProvider: step.provider,
        selectedModel: step.model,
        selectedMode: step.modeId,
        selectedThinkingOptionId: step.thinkingOptionId,
        selectedProfileId: step.profileId,
      });
    },
    addStep(kind) {
      if (closed || state.steps.length >= MAX_AUTOMATION_NODES) {
        return;
      }
      const from = state.steps.find((step) => step.id === state.selectedStepId);
      const fromAgentOutput = from?.kind === "agent" ? stepOutputReference(from.id) : "";
      const step: AutomationFormStep =
        kind === "agent"
          ? {
              id: nextStepId(state.steps, "step"),
              kind: "agent",
              title: `Step ${state.steps.length + 1}`,
              prompt: fromAgentOutput ? `Previous step's output:\n${fromAgentOutput}\n\n` : "",
              provider: state.selectedProvider,
              model: state.selectedModel,
              modeId: "",
              thinkingOptionId: state.selectedThinkingOptionId,
              profileId: "",
            }
          : {
              id: nextStepId(state.steps, "check"),
              kind: "condition",
              title: "Check",
              input: fromAgentOutput,
              operator: "contains",
              value: "",
            };
      const edge: AutomationEdge | null = from
        ? { from: from.id, to: step.id, ...(from.kind === "condition" ? { branch: "true" } : {}) }
        : null;
      const next: AutomationFormState = {
        ...state,
        steps: [...state.steps, step],
        edges: edge ? [...state.edges, edge] : state.edges,
        selectedStepId: step.id,
      };
      if (step.kind === "condition") {
        publish(next);
        return;
      }
      publish({
        ...next,
        agentStepId: step.id,
        prompt: step.prompt,
        selectedMode: "",
        selectedProfileId: "",
      });
    },
    removeStep(stepId) {
      const remaining = state.steps.filter((step) => step.id !== stepId);
      const firstAgent = remaining.find((step) => step.kind === "agent");
      if (closed || remaining.length === state.steps.length || !firstAgent) {
        return;
      }
      const edges = state.edges.filter((edge) => edge.from !== stepId && edge.to !== stepId);
      // Drop the removed step's agent from the mirror before re-pointing it.
      const base: AutomationFormState = { ...state, steps: remaining, edges };
      if (stepId !== state.agentStepId) {
        publish({
          ...base,
          selectedStepId:
            stepId === state.selectedStepId ? state.agentStepId : state.selectedStepId,
        });
        return;
      }
      publish({
        ...base,
        selectedStepId: firstAgent.id,
        agentStepId: firstAgent.id,
        prompt: firstAgent.prompt,
        selectedProvider: firstAgent.provider,
        selectedModel: firstAgent.model,
        selectedMode: firstAgent.modeId,
        selectedThinkingOptionId: firstAgent.thinkingOptionId,
        selectedProfileId: firstAgent.profileId,
      });
    },
    connectSteps(from, to, branch) {
      const source = state.steps.find((step) => step.id === from);
      if (closed || !source || !state.steps.some((step) => step.id === to)) {
        return "Step not found";
      }
      if (from === to) {
        return "A step cannot follow itself";
      }
      if (source.kind === "condition" && !branch) {
        return "Choose whether this path runs when the check is true or false";
      }
      const edgeBranch = source.kind === "condition" ? branch : undefined;
      if (
        state.edges.some(
          (edge) => edge.from === from && edge.to === to && edge.branch === edgeBranch,
        )
      ) {
        return "These steps are already linked";
      }
      if (upstreamNodeIds({ nodes: [], edges: state.edges }, from).has(to)) {
        return "That link would make a loop";
      }
      publish({
        ...state,
        edges: [...state.edges, { from, to, ...(edgeBranch ? { branch: edgeBranch } : {}) }],
      });
      return null;
    },
    disconnectSteps(target) {
      publish({
        ...state,
        edges: state.edges.filter(
          (edge) =>
            !(edge.from === target.from && edge.to === target.to && edge.branch === target.branch),
        ),
      });
    },
    setStepTitle(value) {
      publish({
        ...state,
        steps: state.steps.map((step) =>
          step.id === state.selectedStepId ? { ...step, title: value } : step,
        ),
      });
    },
    setCondition(patch) {
      publish({
        ...state,
        steps: state.steps.map((step) =>
          step.id === state.selectedStepId && step.kind === "condition"
            ? { ...step, ...patch }
            : step,
        ),
      });
    },
    setPrRepo(value) {
      publish({ ...state, prRepo: value });
    },
    togglePrEvent(event) {
      const prEvents = state.prEvents.includes(event)
        ? state.prEvents.filter((candidate) => candidate !== event)
        : [...state.prEvents, event];
      publish({ ...state, prEvents });
    },
    setSubmitError(value) {
      publish({ ...state, submitError: value });
    },
  };
}
