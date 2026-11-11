import type {
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
  ProviderSnapshotEntry,
} from "@pimi/protocol/agent-types";
import type { Automation, AutomationAgentNode } from "@pimi/protocol/automation/types";
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
  };
}

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

export type AutomationFormTriggerKind = "schedule" | "manual";
type CronCadence = Extract<Cadence, { type: "cron" }>;
type ProviderResolutionStatus = "idle" | "pending" | "complete";

export interface AutomationFormState {
  mode: "create" | "edit";
  triggerKind: AutomationFormTriggerKind;
  name: string;
  prompt: string;
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

// The form edits the single agent step of an automation; this is what it reads back.
interface AgentStepConfig {
  cwd: string;
  provider: AutomationAgentNode["provider"];
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  isolation: "local" | "worktree";
}

function newAgentConfig(automation: AutomationFormSnapshot["automation"]): AgentStepConfig | null {
  const node = automation?.flow.nodes.find((candidate) => candidate.kind === "agent");
  if (!automation || node?.kind !== "agent") {
    return null;
  }
  return {
    cwd: automation.project.cwd,
    provider: node.provider,
    model: node.model,
    modeId: node.modeId,
    thinkingOptionId: node.thinkingOptionId,
    isolation: node.workspace === "worktree" ? "worktree" : "local",
  };
}

export function automationAgentPrompt(automation: AutomationFormSnapshot["automation"]): string {
  const node = automation?.flow.nodes.find((candidate) => candidate.kind === "agent");
  return node?.kind === "agent" ? node.prompt : "";
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
  const config = newAgentConfig(input.snapshot.automation);
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

function formatInitialMaxRuns(automation: AutomationFormSnapshot["automation"]): string {
  if (automation?.limits.maxRuns == null) {
    return "";
  }
  return String(automation.limits.maxRuns);
}

function resolveInitialSubmitCadence(
  automation: AutomationFormSnapshot["automation"],
  initialCadence: CronCadence,
): CronCadence | undefined {
  return automation ? undefined : initialCadence;
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
  const nextState: AutomationFormState = {
    ...input.state,
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
  return { ...nextState, disclosure, canSubmit: resolveCanSubmit({ ...nextState, disclosure }) };
}

function buildInitialDraft(snapshot: AutomationFormSnapshot) {
  const template = snapshot.mode === "create" ? snapshot.defaults.template : undefined;
  const trigger = snapshot.automation?.trigger;
  const storedCadence = trigger?.kind === "schedule" ? trigger.cadence : undefined;
  const cadence = normalizeAutomationFormCadence(
    storedCadence ?? template?.cadence ?? DEFAULT_CADENCE,
    snapshot.defaults.timezone ?? DEFAULT_TIMEZONE,
  );
  const triggerKind: AutomationFormTriggerKind = trigger?.kind === "manual" ? "manual" : "schedule";
  return {
    triggerKind,
    name: snapshot.automation?.name ?? template?.name ?? "",
    prompt: snapshot.automation
      ? automationAgentPrompt(snapshot.automation)
      : (template?.prompt ?? ""),
    maxRuns: formatInitialMaxRuns(snapshot.automation),
    cadence,
    submitCadence: resolveInitialSubmitCadence(
      storedCadence ? snapshot.automation : undefined,
      cadence,
    ),
  };
}

function buildInitialState(snapshot: AutomationFormSnapshot): AutomationFormState {
  const selectedServerId = resolveInitialServerId(snapshot);
  const config = newAgentConfig(snapshot.automation);
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
  const initialAgentConfig = newAgentConfig(snapshot.automation);
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
    setSubmitError(value) {
      publish({ ...state, submitError: value });
    },
  };
}
