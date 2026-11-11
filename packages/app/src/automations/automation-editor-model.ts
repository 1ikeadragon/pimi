import type {
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
  ProviderSnapshotEntry,
} from "@pimi/protocol/agent-types";
import type {
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
  topologicalOrder,
  upstreamNodeIds,
  validateAutomationDefinition,
  type AutomationIssueCode,
} from "@pimi/protocol/automation/validate";
import type { Cadence } from "@pimi/protocol/schedule/cadence";
import type { FormPreferences } from "@/create-agent-preferences/preferences";
import {
  buildSelectableProviderSelectorProviders,
  type ProviderSelectorProvider,
} from "@/provider-selection/provider-selection";
import { filterSelectableModels } from "@/provider-selection/model-catalog";
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
import { validateCron } from "@/utils/automation-format";
import type { AutomationTemplate } from "./automation-templates";
import { PROJECT_OPTION_PREFIX, type AutomationProjectTarget } from "./automation-project-targets";

/**
 * The automation editor's model: the step graph, the trigger, and the automation's settings. Plain
 * TypeScript with no React, opened once per editor mount (docs/forms.md). The trigger is not a
 * stored step; on the canvas it feeds every step that has no step before it, which is how the
 * daemon starts a run.
 */

/** The trigger's id on the canvas. `@` is not allowed in a step id, so it never collides. */
export const TRIGGER_NODE_ID = "@trigger";

export interface AutomationEditorDisplay {
  label: string;
}

export interface AutomationEditorHost {
  serverId: string;
  label: string;
}

export type EditorTriggerKind = "manual" | "cron" | "interval" | "pull_request";
export type EditorWorkspace = AutomationAgentNode["workspace"];
type CronCadence = Extract<Cadence, { type: "cron" }>;

export interface EditorAgentStep {
  id: string;
  kind: "agent";
  title: string;
  prompt: string;
  /** Null: the step uses the automation's default model, mode and thinking. */
  provider: AgentProvider | null;
  model: string;
  modeId: string;
  thinkingOptionId: string;
  profileId: string;
  workspace: EditorWorkspace;
  featureValues?: AutomationAgentNode["featureValues"];
}

export interface EditorCheckStep {
  id: string;
  kind: "condition";
  title: string;
  input: string;
  operator: AutomationConditionOperator;
  value: string;
}

export type EditorStep = EditorAgentStep | EditorCheckStep;

export type EditorSelection = { kind: "none" } | { kind: "trigger" } | { kind: "step"; id: string };

export interface EditorDefaults {
  provider: AgentProvider | null;
  model: string;
  modeId: string;
  thinkingOptionId: string;
}

export type EditorProblemCode =
  | AutomationIssueCode
  | "missing_model"
  | "invalid_cron"
  | "loop_member"
  | "choose_project";

/** Where a problem shows: on a step, on the trigger, on the name, or in the settings. */
export type EditorProblemTarget = "name" | "settings" | typeof TRIGGER_NODE_ID | (string & {});

export interface EditorProblem {
  target: EditorProblemTarget;
  code: EditorProblemCode;
  /** English fallback for codes the editor does not word itself. */
  message: string;
  ref?: string;
  cronError?: string;
}

/** The user-editable part of the editor, kept across the editor unmounting. */
export interface AutomationEditorDraft {
  name: string;
  triggerKind: EditorTriggerKind;
  cron: CronCadence;
  intervalMs: number;
  prRepo: string;
  prEvents: PullRequestEvent[];
  steps: EditorStep[];
  edges: AutomationEdge[];
  maxRuns: string;
  selectedServerId: string | null;
  workingDir: string;
  projectDisplay: AutomationEditorDisplay | null;
  defaults: EditorDefaults;
}

export interface AutomationEditorSnapshot {
  mode: "create" | "edit";
  /** Unsaved edits to reopen on, instead of `source`/`template`. The editor opens dirty. */
  draft?: AutomationEditorDraft;
  /**
   * What the editor opens on: the stored automation when editing; a template, a duplicate or
   * nothing when creating.
   */
  source?: Pick<AutomationDefinition, "name" | "project" | "trigger" | "flow" | "limits">;
  template?: AutomationTemplate;
  hosts: readonly AutomationEditorHost[];
  serverId?: string | null;
  projectTargets: readonly AutomationProjectTarget[];
  preferences?: FormPreferences;
  timezone: string;
  /** Translated base titles for new steps; the model numbers them. */
  newStepTitles: { agent: string; check: string };
}

export interface AutomationEditorProjectOption {
  id: string;
  value: string;
  label: string;
  testID: string;
}

type ProviderResolutionStatus = "pending" | "complete";

export interface AutomationEditorState {
  mode: "create" | "edit";
  name: string;
  triggerKind: EditorTriggerKind;
  cron: CronCadence;
  intervalMs: number;
  prRepo: string;
  prEvents: PullRequestEvent[];
  steps: EditorStep[];
  edges: AutomationEdge[];
  selection: EditorSelection;
  maxRuns: string;
  hosts: AutomationEditorHost[];
  selectedServerId: string | null;
  projectOptions: AutomationEditorProjectOption[];
  selectedProjectOptionId: string;
  projectDisplay: AutomationEditorDisplay | null;
  workingDir: string;
  /** Known only once the project list has the project; null until then. */
  projectIsGit: boolean | null;
  defaults: EditorDefaults;
  providerEntries: readonly ProviderSnapshotEntry[];
  modelSelectorProviders: ProviderSelectorProvider[];
  providerResolutionByServerId: Record<string, ProviderResolutionStatus>;
  providerSnapshotRequest: { serverId: string; cwd: string } | null;
  problems: EditorProblem[];
  /** Problems keyed by target, for the canvas. */
  problemsByTarget: ReadonlyMap<string, EditorProblem[]>;
  dirty: boolean;
  canSave: boolean;
  submitError: string | null;
}

export type ConnectRefusal = "not_found" | "self" | "branch_required" | "duplicate" | "loop";

export interface AutomationEditorModel {
  getState: () => AutomationEditorState;
  /** The editable content as it stands now. */
  getDraft: () => AutomationEditorDraft;
  subscribe: (listener: () => void) => () => void;
  close: () => void;
  applyHosts: (hosts: readonly AutomationEditorHost[]) => void;
  applyProjectTargets: (targets: readonly AutomationProjectTarget[]) => void;
  applyPreferences: (preferences: FormPreferences | undefined) => void;
  applyProviderSnapshot: (serverId: string, entries: ProviderSnapshotEntry[]) => void;
  select: (selection: EditorSelection) => void;
  setName: (value: string) => void;
  setTriggerKind: (value: EditorTriggerKind) => void;
  setCron: (value: Cadence) => void;
  setIntervalMs: (value: number) => void;
  setPrRepo: (value: string) => void;
  togglePrEvent: (event: PullRequestEvent) => void;
  setMaxRuns: (value: string) => void;
  setHost: (serverId: string) => void;
  setProject: (optionId: string, display: AutomationEditorDisplay) => void;
  setDefaultModel: (provider: AgentProvider, modelId: string) => void;
  setDefaultThinking: (thinkingOptionId: string) => void;
  setDefaultMode: (modeId: string) => void;
  /** Adds a step after `from` (a step or the trigger) and selects it. Returns its id. */
  addStep: (
    kind: EditorStep["kind"],
    from: { nodeId: string; branch?: AutomationEdgeBranch } | null,
  ) => string | null;
  /** Puts a new step on a link: `from -> new -> to`. Returns its id. */
  insertStep: (kind: EditorStep["kind"], edge: AutomationEdge) => string | null;
  removeStep: (stepId: string) => void;
  connect: (from: string, to: string, branch?: AutomationEdgeBranch) => ConnectRefusal | null;
  disconnect: (edge: AutomationEdge) => void;
  updateAgentStep: (
    stepId: string,
    patch: Partial<Pick<EditorAgentStep, "title" | "prompt" | "profileId" | "workspace">>,
  ) => void;
  /** A null provider puts the step back on the automation's default model. */
  setStepModel: (stepId: string, provider: AgentProvider | null, modelId: string) => void;
  setStepThinking: (stepId: string, thinkingOptionId: string) => void;
  setStepMode: (stepId: string, modeId: string) => void;
  updateCheckStep: (
    stepId: string,
    patch: Partial<Pick<EditorCheckStep, "title" | "input" | "operator" | "value">>,
  ) => void;
  markSaved: () => void;
  setSubmitError: (value: string | null) => void;
}

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_CRON = "0 9 * * 1-5";

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

export function isTriggerNode(nodeId: string): boolean {
  return nodeId === TRIGGER_NODE_ID;
}

/** Steps with no step before them: the trigger starts them. */
export function rootStepIds(
  steps: readonly EditorStep[],
  edges: readonly AutomationEdge[],
): string[] {
  const targets = new Set(edges.map((edge) => edge.to));
  return steps.filter((step) => !targets.has(step.id)).map((step) => step.id);
}

export function sameEdge(a: AutomationEdge, b: AutomationEdge): boolean {
  return a.from === b.from && a.to === b.to && a.branch === b.branch;
}

/** Agent steps whose output `stepId` can read: those that always finish before it. */
export function upstreamAgentSteps(
  state: Pick<AutomationEditorState, "steps" | "edges">,
  stepId: string,
): EditorAgentStep[] {
  const upstream = upstreamNodeIds({ nodes: [], edges: state.edges }, stepId);
  return state.steps.filter(
    (step): step is EditorAgentStep => step.kind === "agent" && upstream.has(step.id),
  );
}

/** Steps `from` may link to without making a loop or repeating a link. */
export function connectableTargets(
  state: Pick<AutomationEditorState, "steps" | "edges">,
  from: string,
  branch?: AutomationEdgeBranch,
): EditorStep[] {
  const upstream = upstreamNodeIds({ nodes: [], edges: state.edges }, from);
  return state.steps.filter(
    (step) =>
      step.id !== from &&
      !upstream.has(step.id) &&
      !state.edges.some(
        (edge) => edge.from === from && edge.to === step.id && edge.branch === branch,
      ),
  );
}

function nextStepId(steps: readonly EditorStep[], prefix: string): string {
  const ids = new Set(steps.map((step) => step.id));
  let index = steps.filter((step) => step.id.startsWith(prefix)).length + 1;
  while (ids.has(`${prefix}${index}`)) {
    index += 1;
  }
  return `${prefix}${index}`;
}

function wouldLoop(edges: readonly AutomationEdge[], from: string, to: string): boolean {
  return from === to || upstreamNodeIds({ nodes: [], edges: [...edges] }, from).has(to);
}

// ---------------------------------------------------------------------------
// Definition building
// ---------------------------------------------------------------------------

function resolveStepWorkspace(
  step: EditorAgentStep,
  projectIsGit: boolean | null,
): EditorWorkspace {
  // A worktree needs a git project; an unknown project keeps what was stored.
  return step.workspace === "worktree" && projectIsGit === false ? "project" : step.workspace;
}

function buildAgentNode(
  step: EditorAgentStep,
  defaults: EditorDefaults,
  projectIsGit: boolean | null,
  placeholderProvider?: AgentProvider,
): AutomationAgentNode | null {
  const inherits = step.provider === null;
  const provider = step.provider ?? defaults.provider ?? placeholderProvider ?? null;
  if (!provider) {
    return null;
  }
  const model = (inherits ? defaults.model : step.model).trim();
  const modeId = (inherits ? defaults.modeId : step.modeId).trim();
  const thinkingOptionId = (inherits ? defaults.thinkingOptionId : step.thinkingOptionId).trim();
  return {
    id: step.id,
    kind: "agent",
    title: step.title.trim() || step.id,
    ...(step.profileId ? { profileId: step.profileId } : {}),
    provider,
    ...(model ? { model } : {}),
    ...(modeId ? { modeId } : {}),
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
    ...(step.featureValues ? { featureValues: step.featureValues } : {}),
    workspace: resolveStepWorkspace(step, projectIsGit),
    prompt: step.prompt.trim(),
  };
}

function buildFlow(
  state: AutomationEditorState,
  placeholderProvider?: AgentProvider,
): AutomationFlow {
  const nodes: AutomationNode[] = [];
  for (const step of state.steps) {
    if (step.kind === "condition") {
      nodes.push({ ...step, title: step.title.trim() || step.id });
      continue;
    }
    const node = buildAgentNode(step, state.defaults, state.projectIsGit, placeholderProvider);
    if (!node) {
      throw new Error(`Choose a model for step ${step.title || step.id}`);
    }
    nodes.push(node);
  }
  return { nodes, edges: state.edges };
}

function buildTrigger(state: AutomationEditorState): AutomationTrigger {
  switch (state.triggerKind) {
    case "manual":
      return { kind: "manual" };
    case "pull_request":
      return { kind: "pull_request", repo: state.prRepo.trim(), events: state.prEvents };
    case "interval":
      return { kind: "schedule", cadence: { type: "every", everyMs: state.intervalMs } };
    case "cron":
      return {
        kind: "schedule",
        cadence: { ...state.cron, expression: state.cron.expression.trim() },
      };
  }
}

function parseMaxRuns(raw: string): number | null {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** The definition to save. Throws when a step has no model; `canSave` is false then. */
export function buildAutomationEditorDefinition(
  state: AutomationEditorState,
  stored?: Pick<AutomationDefinition, "description" | "limits">,
): AutomationDefinition {
  return {
    name: state.name.trim(),
    description: stored?.description ?? null,
    project: { cwd: state.workingDir.trim() },
    trigger: buildTrigger(state),
    flow: buildFlow(state),
    limits: { ...stored?.limits, maxRuns: parseMaxRuns(state.maxRuns) },
  };
}

// ---------------------------------------------------------------------------
// Problems
// ---------------------------------------------------------------------------

function issueTarget(code: AutomationIssueCode, nodeId: string | undefined): EditorProblemTarget {
  if (nodeId) {
    return nodeId;
  }
  switch (code) {
    case "name_required":
      return "name";
    case "project_required":
      return "settings";
    default:
      return TRIGGER_NODE_ID;
  }
}

function resolveProblems(state: AutomationEditorState): EditorProblem[] {
  const problems: EditorProblem[] = [];
  for (const step of state.steps) {
    if (step.kind === "agent" && step.provider === null && state.defaults.provider === null) {
      problems.push({ target: step.id, code: "missing_model", message: "Choose a model" });
    }
  }
  if (state.triggerKind === "cron") {
    const cronError = validateCron(state.cron.expression.trim());
    if (cronError) {
      problems.push({
        target: TRIGGER_NODE_ID,
        code: "invalid_cron",
        message: cronError,
        cronError,
      });
    }
  }
  const flow = buildFlow(state, "claude");
  const issues = validateAutomationDefinition({
    name: state.name,
    project: { cwd: state.workingDir },
    trigger: buildTrigger(state),
    flow,
  });
  for (const issue of issues) {
    if (issue.code === "project_required" && !state.selectedServerId) {
      problems.push({ target: "settings", code: "choose_project", message: issue.message });
      continue;
    }
    if (issue.code === "cycle") {
      // Name every step on or after the loop, so the canvas can mark them.
      const ordered = new Set(topologicalOrder(flow) ?? []);
      const order = topologicalOrderPartial(flow);
      for (const step of state.steps) {
        if (!ordered.has(step.id) && !order.has(step.id)) {
          problems.push({ target: step.id, code: "loop_member", message: issue.message });
        }
      }
      continue;
    }
    problems.push({
      target: issueTarget(issue.code, issue.nodeId),
      code: issue.code,
      message: issue.message,
      ...(issue.ref ? { ref: issue.ref } : {}),
    });
  }
  return problems;
}

/** The steps Kahn's algorithm reaches before it stalls on a loop. */
function topologicalOrderPartial(flow: AutomationFlow): Set<string> {
  const indegree = new Map(flow.nodes.map((node) => [node.id, 0]));
  for (const edge of flow.edges) {
    if (indegree.has(edge.to) && indegree.has(edge.from)) {
      indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    }
  }
  const ready = flow.nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  const reached = new Set<string>();
  while (ready.length > 0) {
    const id = ready.shift()!;
    reached.add(id);
    for (const edge of flow.edges) {
      if (edge.from !== id || !indegree.has(edge.to)) {
        continue;
      }
      const remaining = (indegree.get(edge.to) ?? 0) - 1;
      indegree.set(edge.to, remaining);
      if (remaining === 0) {
        ready.push(edge.to);
      }
    }
  }
  return reached;
}

function groupProblems(problems: readonly EditorProblem[]): Map<string, EditorProblem[]> {
  const byTarget = new Map<string, EditorProblem[]>();
  for (const problem of problems) {
    const list = byTarget.get(problem.target) ?? [];
    list.push(problem);
    byTarget.set(problem.target, list);
  }
  return byTarget;
}

// ---------------------------------------------------------------------------
// Project and provider helpers
// ---------------------------------------------------------------------------

function buildProjectOptions(
  targets: readonly AutomationProjectTarget[],
  serverId: string | null,
): AutomationEditorProjectOption[] {
  if (!serverId) {
    return [];
  }
  return targets
    .filter((target) => target.serverId === serverId)
    .map((target) => ({
      id: target.optionId,
      value: target.optionId,
      label: target.projectName,
      testID: `automation-project-option-${target.optionId
        .slice(PROJECT_OPTION_PREFIX.length)
        .replace(/^[^:]+:/, "")}`,
    }));
}

function findProjectTarget(
  targets: readonly AutomationProjectTarget[],
  serverId: string | null,
  cwd: string,
): AutomationProjectTarget | null {
  const trimmed = cwd.trim();
  if (!serverId || !trimmed) {
    return null;
  }
  return targets.find((target) => target.serverId === serverId && target.cwd === trimmed) ?? null;
}

function buildProviderModelsByProvider(
  entries: readonly ProviderSnapshotEntry[],
): ProviderModelsByProvider {
  const map: ProviderModelsByProvider = new Map();
  for (const entry of entries) {
    map.set(entry.provider, filterSelectableModels(entry.models ?? null));
  }
  return map;
}

export function availableModelsFor(
  entries: readonly ProviderSnapshotEntry[],
  provider: AgentProvider | null,
): AgentModelDefinition[] | null {
  if (!provider) {
    return null;
  }
  return filterSelectableModels(
    entries.find((entry) => entry.provider === provider)?.models ?? null,
  );
}

export function modeOptionsFor(
  entries: readonly ProviderSnapshotEntry[],
  provider: AgentProvider | null,
): AgentMode[] {
  return entries.find((entry) => entry.provider === provider)?.modes ?? [];
}

export function thinkingOptionsFor(
  entries: readonly ProviderSnapshotEntry[],
  provider: AgentProvider | null,
  modelId: string,
): NonNullable<AgentModelDefinition["thinkingOptions"]> {
  const models = availableModelsFor(entries, provider);
  const id = modelId.trim();
  if (!models || !id) {
    return [];
  }
  const model = models.find((candidate) => candidate.id === id) ?? null;
  return model?.thinkingOptions ?? [];
}

/** A model id's label from the host's catalog, or the id itself. */
export function modelLabel(
  entries: readonly ProviderSnapshotEntry[],
  provider: AgentProvider | null,
  modelId: string,
): string {
  const id = modelId.trim();
  const models = availableModelsFor(entries, provider);
  return models?.find((model) => model.id === id)?.label ?? id;
}

/** The provider, model, mode and thinking a step runs with. */
export function effectiveStepModel(
  step: EditorAgentStep,
  defaults: EditorDefaults,
): EditorDefaults {
  if (step.provider === null) {
    return defaults;
  }
  return {
    provider: step.provider,
    model: step.model,
    modeId: step.modeId,
    thinkingOptionId: step.thinkingOptionId,
  };
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

function firstAgentNode(source: AutomationEditorSnapshot["source"]): AutomationAgentNode | null {
  const node = source?.flow.nodes.find((candidate) => candidate.kind === "agent");
  return node?.kind === "agent" ? node : null;
}

function seedDefaults(source: AutomationEditorSnapshot["source"]): EditorDefaults {
  const node = firstAgentNode(source);
  return {
    provider: node?.provider ?? null,
    model: node?.model ?? "",
    modeId: node?.modeId ?? "",
    thinkingOptionId: node?.thinkingOptionId ?? "",
  };
}

// A step that runs with exactly the defaults inherits them, so changing the default model
// changes it too.
function toEditorStep(node: AutomationNode, defaults: EditorDefaults): EditorStep {
  if (node.kind === "condition") {
    return { ...node };
  }
  const inherits =
    node.provider === defaults.provider &&
    (node.model ?? "") === defaults.model &&
    (node.modeId ?? "") === defaults.modeId &&
    (node.thinkingOptionId ?? "") === defaults.thinkingOptionId;
  return {
    id: node.id,
    kind: "agent",
    title: node.title,
    prompt: node.prompt,
    provider: inherits ? null : node.provider,
    model: inherits ? "" : (node.model ?? ""),
    modeId: inherits ? "" : (node.modeId ?? ""),
    thinkingOptionId: inherits ? "" : (node.thinkingOptionId ?? ""),
    profileId: node.profileId ?? "",
    workspace: node.workspace,
    ...(node.featureValues ? { featureValues: node.featureValues } : {}),
  };
}

function preferredWorkspace(preferences: FormPreferences | null | undefined): EditorWorkspace {
  return preferences?.isolation === "worktree" ? "worktree" : "project";
}

function seedTrigger(
  trigger: AutomationTrigger | undefined,
  template: AutomationTemplate | undefined,
  timezone: string,
): Pick<AutomationEditorState, "triggerKind" | "cron" | "intervalMs" | "prRepo" | "prEvents"> {
  const base = {
    cron: { type: "cron" as const, expression: DEFAULT_CRON, timezone },
    intervalMs: DEFAULT_INTERVAL_MS,
    prRepo: "",
    prEvents: ["opened", "synchronize"] as PullRequestEvent[],
  };
  if (!trigger) {
    if (template) {
      return {
        ...base,
        triggerKind: "cron",
        cron: { ...template.cadence, timezone: template.cadence.timezone ?? timezone },
      };
    }
    return { ...base, triggerKind: "manual" };
  }
  switch (trigger.kind) {
    case "manual":
      return { ...base, triggerKind: "manual" };
    case "pull_request":
      return {
        ...base,
        triggerKind: "pull_request",
        prRepo: trigger.repo,
        prEvents: trigger.events,
      };
    case "schedule":
      // A stored cron keeps its timezone, or its lack of one, until the trigger is edited.
      return trigger.cadence.type === "every"
        ? { ...base, triggerKind: "interval", intervalMs: trigger.cadence.everyMs }
        : { ...base, triggerKind: "cron", cron: trigger.cadence };
  }
}

function seedSteps(
  snapshot: AutomationEditorSnapshot,
  defaults: EditorDefaults,
): {
  steps: EditorStep[];
  edges: AutomationEdge[];
} {
  if (snapshot.source) {
    return {
      steps: snapshot.source.flow.nodes.map((node) => toEditorStep(node, defaults)),
      edges: snapshot.source.flow.edges.map((edge) => ({ ...edge })),
    };
  }
  if (snapshot.template) {
    return {
      steps: [
        {
          id: "step1",
          kind: "agent",
          title: snapshot.template.name,
          prompt: snapshot.template.prompt,
          provider: null,
          model: "",
          modeId: "",
          thinkingOptionId: "",
          profileId: snapshot.template.profileId ?? "",
          workspace: preferredWorkspace(snapshot.preferences),
        },
      ],
      edges: [],
    };
  }
  return { steps: [], edges: [] };
}

function resolveInitialServerId(snapshot: AutomationEditorSnapshot): string | null {
  if (snapshot.serverId) {
    return snapshot.serverId;
  }
  return snapshot.hosts.length === 1 ? (snapshot.hosts[0]?.serverId ?? null) : null;
}

function seedInitialValues(defaults: EditorDefaults): FormInitialValues | undefined {
  if (!defaults.provider) {
    return undefined;
  }
  return {
    provider: defaults.provider,
    model: defaults.model || null,
    modeId: defaults.modeId || null,
    thinkingOptionId: defaults.thinkingOptionId || null,
  };
}

function seedProjectDisplay(
  target: AutomationProjectTarget | null,
  workingDir: string,
): AutomationEditorState["projectDisplay"] {
  if (target) {
    return { label: target.projectName };
  }
  if (workingDir.trim()) {
    return { label: shortenPath(workingDir) };
  }
  return null;
}

function seedContent(
  snapshot: AutomationEditorSnapshot,
  seededDefaults: EditorDefaults,
): Pick<
  AutomationEditorState,
  | "name"
  | "triggerKind"
  | "cron"
  | "intervalMs"
  | "prRepo"
  | "prEvents"
  | "steps"
  | "edges"
  | "maxRuns"
> {
  const { draft } = snapshot;
  if (draft) {
    return {
      name: draft.name,
      triggerKind: draft.triggerKind,
      cron: draft.cron,
      intervalMs: draft.intervalMs,
      prRepo: draft.prRepo,
      prEvents: [...draft.prEvents],
      steps: draft.steps,
      edges: draft.edges,
      maxRuns: draft.maxRuns,
    };
  }
  const maxRuns = snapshot.source?.limits?.maxRuns;
  return {
    name: snapshot.source?.name ?? snapshot.template?.name ?? "",
    ...seedTrigger(snapshot.source?.trigger, snapshot.template, snapshot.timezone),
    ...seedSteps(snapshot, seededDefaults),
    maxRuns: maxRuns ? String(maxRuns) : "",
  };
}

/** The editor's state before host providers resolve, built from what it was opened with. */
function seedEditorState(
  snapshot: AutomationEditorSnapshot,
  seededDefaults: EditorDefaults,
  projectTargets: AutomationEditorSnapshot["projectTargets"],
): AutomationEditorState {
  const draft = snapshot.draft;
  const selectedServerId = draft ? draft.selectedServerId : resolveInitialServerId(snapshot);
  const workingDir = draft ? draft.workingDir : (snapshot.source?.project.cwd ?? "");
  const initialTarget = findProjectTarget(projectTargets, selectedServerId, workingDir);
  const providerSnapshotRequest =
    selectedServerId && workingDir.trim() ? { serverId: selectedServerId, cwd: workingDir } : null;
  const content = seedContent(snapshot, seededDefaults);
  return {
    mode: snapshot.mode,
    ...content,
    selection: { kind: "none" },
    hosts: [...snapshot.hosts],
    selectedServerId,
    projectOptions: [],
    selectedProjectOptionId: initialTarget?.optionId ?? "",
    projectDisplay: draft?.projectDisplay ?? seedProjectDisplay(initialTarget, workingDir),
    workingDir,
    projectIsGit: null,
    defaults: seededDefaults,
    providerEntries: [],
    modelSelectorProviders: [],
    providerResolutionByServerId: providerSnapshotRequest
      ? { [providerSnapshotRequest.serverId]: "pending" }
      : {},
    providerSnapshotRequest,
    problems: [],
    problemsByTarget: new Map(),
    dirty: false,
    canSave: false,
    submitError: null,
  };
}

function draftOf(state: AutomationEditorState): AutomationEditorDraft {
  return {
    name: state.name,
    triggerKind: state.triggerKind,
    cron: state.cron,
    intervalMs: state.intervalMs,
    prRepo: state.prRepo,
    prEvents: state.prEvents,
    steps: state.steps,
    edges: state.edges,
    maxRuns: state.maxRuns,
    selectedServerId: state.selectedServerId,
    workingDir: state.workingDir,
    projectDisplay: state.projectDisplay,
    defaults: state.defaults,
  };
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

export function openAutomationEditor(snapshot: AutomationEditorSnapshot): AutomationEditorModel {
  const listeners = new Set<() => void>();
  let closed = false;
  let hosts = snapshot.hosts;
  let projectTargets = snapshot.projectTargets;
  let preferences = snapshot.preferences ?? null;
  let userModified: UserModifiedFields = { ...INITIAL_USER_MODIFIED };
  // Edits since the last save; the editor is dirty while this is above the saved mark.
  let edits = snapshot.draft ? 1 : 0;
  let savedEdits = 0;
  const thinkingDrafts = new Map<string, string>();
  const seededDefaults = snapshot.draft?.defaults ?? seedDefaults(snapshot.source);
  const initialValues = seedInitialValues(seededDefaults);
  const timezone = snapshot.timezone;

  let state: AutomationEditorState = derive(
    seedEditorState(snapshot, seededDefaults, projectTargets),
  );

  function derive(next: AutomationEditorState): AutomationEditorState {
    const projectTarget = findProjectTarget(projectTargets, next.selectedServerId, next.workingDir);
    const withProject: AutomationEditorState = {
      ...next,
      hosts: [...hosts],
      projectOptions: buildProjectOptions(projectTargets, next.selectedServerId),
      selectedProjectOptionId: projectTarget?.optionId ?? next.selectedProjectOptionId,
      projectDisplay: projectTarget ? { label: projectTarget.projectName } : next.projectDisplay,
      projectIsGit: projectTarget ? projectTarget.isGit : next.projectIsGit,
      dirty: edits > savedEdits,
    };
    const problems = resolveProblems(withProject);
    return {
      ...withProject,
      problems,
      problemsByTarget: groupProblems(problems),
      canSave: problems.length === 0 && (withProject.mode === "create" || withProject.dirty),
    };
  }

  function publish(next: AutomationEditorState): void {
    if (closed) {
      return;
    }
    state = derive(next);
    for (const listener of listeners) {
      listener();
    }
  }

  /** A user edit: counts toward unsaved changes and clears a stale save error. */
  function edit(next: AutomationEditorState): void {
    // An edit that leaves the content as it was (the same text set again) is not a change.
    if (JSON.stringify(draftOf(next)) !== JSON.stringify(draftOf(state))) {
      edits += 1;
    }
    publish({ ...next, submitError: null });
  }

  function resolveDefaults(next: AutomationEditorState): AutomationEditorState {
    if (next.providerEntries.length === 0) {
      return next;
    }
    const providerDefinitions = buildProviderDefinitions([...next.providerEntries]);
    const allowed = buildProviderDefinitionMapForStatuses({
      snapshotEntries: [...next.providerEntries],
      providerDefinitions,
      statuses: RESOLVABLE_PROVIDER_STATUSES,
    });
    const current: FormState = {
      provider: next.defaults.provider,
      model: next.defaults.model,
      modeId: next.defaults.modeId,
      thinkingOptionId: next.defaults.thinkingOptionId,
    };
    const resolved = resolveFormStateFromProviderModels(
      initialValues,
      snapshot.mode === "edit" ? null : preferences,
      buildProviderModelsByProvider(next.providerEntries),
      userModified,
      current,
      allowed,
    );
    // The shared resolver falls back to the provider's chat mode; an automation leaves the mode
    // empty so its runs use the unattended mode.
    const modeId = userModified.modeId ? resolved.modeId : (initialValues?.modeId ?? "");
    return {
      ...next,
      defaults: {
        provider: resolved.provider,
        model: resolved.model,
        modeId,
        thinkingOptionId: resolved.thinkingOptionId,
      },
    };
  }

  function clearProviders(next: AutomationEditorState): AutomationEditorState {
    return {
      ...next,
      providerEntries: [],
      modelSelectorProviders: [],
      defaults: { provider: null, model: "", modeId: "", thinkingOptionId: "" },
      providerSnapshotRequest: null,
    };
  }

  function pickThinking(
    provider: AgentProvider,
    modelId: string,
    entries: readonly ProviderSnapshotEntry[],
  ): string {
    return resolveThinkingOptionId({
      availableModels: availableModelsFor(entries, provider),
      modelId,
      requestedThinkingOptionId: thinkingDrafts.get(`${provider}:${modelId}`) ?? "",
    });
  }

  function pickModel(provider: AgentProvider, modelId: string): string {
    return (
      modelId.trim() || resolveDefaultModelId(availableModelsFor(state.providerEntries, provider))
    );
  }

  function mapStep(stepId: string, update: (step: EditorStep) => EditorStep): EditorStep[] {
    return state.steps.map((step) => (step.id === stepId ? update(step) : step));
  }

  function newStep(kind: EditorStep["kind"], fromAgent: string | null): EditorStep {
    if (kind === "agent") {
      const id = nextStepId(state.steps, "step");
      return {
        id,
        kind: "agent",
        title: `${snapshot.newStepTitles.agent} ${state.steps.filter((step) => step.kind === "agent").length + 1}`,
        prompt: fromAgent ? `${stepOutputReference(fromAgent)}\n\n` : "",
        provider: null,
        model: "",
        modeId: "",
        thinkingOptionId: "",
        profileId: "",
        workspace: state.projectIsGit === false ? "project" : preferredWorkspace(preferences),
      };
    }
    const id = nextStepId(state.steps, "check");
    return {
      id,
      kind: "condition",
      title: `${snapshot.newStepTitles.check} ${state.steps.filter((step) => step.kind === "condition").length + 1}`,
      input: fromAgent ? stepOutputReference(fromAgent) : "",
      operator: "contains",
      value: "",
    };
  }

  function agentSource(nodeId: string): string | null {
    const step = state.steps.find((candidate) => candidate.id === nodeId);
    return step?.kind === "agent" ? step.id : null;
  }

  return {
    getState: () => state,
    getDraft: () => draftOf(state),
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
    applyHosts(next) {
      if (closed || hosts === next) {
        return;
      }
      hosts = next;
      // Hosts often connect after the editor opens; a lone host is the only choice, so take it.
      const loneHost = next.length === 1 ? next[0] : undefined;
      if (!state.selectedServerId && loneHost) {
        publish({ ...state, selectedServerId: loneHost.serverId });
        return;
      }
      publish(state);
    },
    applyProjectTargets(next) {
      if (closed || projectTargets === next) {
        return;
      }
      projectTargets = next;
      publish(state);
    },
    applyPreferences(next) {
      const normalized = next ?? null;
      if (closed || preferences === normalized) {
        return;
      }
      preferences = normalized;
      publish(resolveDefaults(state));
    },
    applyProviderSnapshot(serverId, entries) {
      if (closed || state.selectedServerId !== serverId) {
        return;
      }
      const pending = state.providerSnapshotRequest?.serverId === serverId;
      publish(
        resolveDefaults({
          ...state,
          providerEntries: entries,
          modelSelectorProviders: buildSelectableProviderSelectorProviders(entries),
          providerResolutionByServerId: pending
            ? { ...state.providerResolutionByServerId, [serverId]: "complete" }
            : state.providerResolutionByServerId,
          providerSnapshotRequest: pending ? null : state.providerSnapshotRequest,
        }),
      );
    },
    select(selection) {
      if (selection.kind === "step" && !state.steps.some((step) => step.id === selection.id)) {
        return;
      }
      publish({ ...state, selection });
    },
    setName(value) {
      edit({ ...state, name: value });
    },
    setTriggerKind(value) {
      if (value !== state.triggerKind) {
        edit({ ...state, triggerKind: value });
      }
    },
    setCron(value) {
      if (value.type !== "cron") {
        return;
      }
      edit({ ...state, cron: { ...value, timezone: value.timezone ?? timezone } });
    },
    setIntervalMs(value) {
      if (Number.isFinite(value) && value > 0) {
        edit({ ...state, intervalMs: Math.round(value) });
      }
    },
    setPrRepo(value) {
      edit({ ...state, prRepo: value });
    },
    togglePrEvent(event) {
      const prEvents = state.prEvents.includes(event)
        ? state.prEvents.filter((candidate) => candidate !== event)
        : [...state.prEvents, event];
      edit({ ...state, prEvents });
    },
    setMaxRuns(value) {
      edit({ ...state, maxRuns: value });
    },
    setHost(serverId) {
      if (state.mode === "edit" || state.selectedServerId === serverId) {
        return;
      }
      edit(
        clearProviders({
          ...state,
          selectedServerId: serverId,
          workingDir: "",
          projectDisplay: null,
          selectedProjectOptionId: "",
          projectIsGit: null,
          providerResolutionByServerId: {},
        }),
      );
    },
    setProject(optionId, display) {
      const projectTarget = projectTargets.find((candidate) => candidate.optionId === optionId);
      if (closed || !projectTarget) {
        return;
      }
      const scopeChanged =
        state.selectedServerId !== projectTarget.serverId || state.workingDir !== projectTarget.cwd;
      if (!scopeChanged) {
        return;
      }
      // Editing keeps the host; a new automation may move to the project's host.
      if (state.mode === "edit" && projectTarget.serverId !== state.selectedServerId) {
        return;
      }
      const next: AutomationEditorState = {
        ...state,
        selectedServerId: projectTarget.serverId,
        workingDir: projectTarget.cwd,
        projectDisplay: display,
        selectedProjectOptionId: projectTarget.optionId,
        projectIsGit: projectTarget.isGit,
      };
      const cleared =
        state.selectedServerId === projectTarget.serverId ? next : clearProviders(next);
      edit({
        ...cleared,
        providerResolutionByServerId: {
          ...cleared.providerResolutionByServerId,
          [projectTarget.serverId]: "pending",
        },
        providerSnapshotRequest: { serverId: projectTarget.serverId, cwd: projectTarget.cwd },
      });
    },
    setDefaultModel(provider, modelId) {
      const model = pickModel(provider, modelId);
      const thinkingOptionId = pickThinking(provider, model, state.providerEntries);
      if (model && thinkingOptionId) {
        thinkingDrafts.set(`${provider}:${model}`, thinkingOptionId);
      }
      userModified = { provider: true, model: true, modeId: true, thinkingOptionId: true };
      const modeId = state.defaults.provider === provider ? state.defaults.modeId : "";
      edit({ ...state, defaults: { provider, model, modeId, thinkingOptionId } });
    },
    setDefaultThinking(thinkingOptionId) {
      const { provider, model } = state.defaults;
      if (provider && model) {
        thinkingDrafts.set(`${provider}:${model}`, thinkingOptionId);
      }
      userModified = { ...userModified, thinkingOptionId: true };
      edit({ ...state, defaults: { ...state.defaults, thinkingOptionId } });
    },
    setDefaultMode(modeId) {
      userModified = { ...userModified, modeId: true };
      edit({ ...state, defaults: { ...state.defaults, modeId } });
    },
    addStep(kind, from) {
      if (closed || state.steps.length >= MAX_AUTOMATION_NODES) {
        return null;
      }
      const fromStep = from && !isTriggerNode(from.nodeId) ? from.nodeId : null;
      if (fromStep && !state.steps.some((step) => step.id === fromStep)) {
        return null;
      }
      const fromCheck = state.steps.find((step) => step.id === fromStep)?.kind === "condition";
      const step = newStep(kind, fromStep ? agentSource(fromStep) : null);
      const edge: AutomationEdge | null = fromStep
        ? {
            from: fromStep,
            to: step.id,
            ...(fromCheck ? { branch: from?.branch ?? "true" } : {}),
          }
        : null;
      edit({
        ...state,
        steps: [...state.steps, step],
        edges: edge ? [...state.edges, edge] : state.edges,
        selection: { kind: "step", id: step.id },
      });
      return step.id;
    },
    insertStep(kind, edge) {
      if (closed || state.steps.length >= MAX_AUTOMATION_NODES) {
        return null;
      }
      const fromTrigger = isTriggerNode(edge.from);
      const step = newStep(kind, fromTrigger ? null : agentSource(edge.from));
      const kept = state.edges.filter((candidate) => !sameEdge(candidate, edge));
      const added: AutomationEdge[] = [
        ...(fromTrigger
          ? []
          : [{ from: edge.from, to: step.id, ...(edge.branch ? { branch: edge.branch } : {}) }]),
        {
          from: step.id,
          to: edge.to,
          ...(step.kind === "condition" ? { branch: "true" as const } : {}),
        },
      ];
      // A step that read its old parent's output now reads the new step's.
      const steps = state.steps.map((candidate) => {
        if (candidate.id !== edge.to || step.kind !== "agent" || fromTrigger) {
          return candidate;
        }
        const oldRef = stepOutputReference(edge.from);
        const newRef = stepOutputReference(step.id);
        return candidate.kind === "agent"
          ? { ...candidate, prompt: candidate.prompt.split(oldRef).join(newRef) }
          : { ...candidate, input: candidate.input.split(oldRef).join(newRef) };
      });
      edit({
        ...state,
        steps: [...steps, step],
        edges: [...kept, ...added],
        selection: { kind: "step", id: step.id },
      });
      return step.id;
    },
    removeStep(stepId) {
      const removed = state.steps.find((step) => step.id === stepId);
      if (closed || !removed) {
        return;
      }
      const incoming = state.edges.filter((edge) => edge.to === stepId);
      const outgoing = state.edges.filter((edge) => edge.from === stepId);
      const edges = state.edges.filter((edge) => edge.from !== stepId && edge.to !== stepId);
      // Removing an agent step from the middle of a chain joins its neighbours. A check's yes and
      // no paths have no single successor, so they are left unlinked.
      if (removed.kind === "agent") {
        for (const into of incoming) {
          for (const out of outgoing) {
            const bridge: AutomationEdge = {
              from: into.from,
              to: out.to,
              ...(into.branch ? { branch: into.branch } : {}),
            };
            if (
              !edges.some((edge) => sameEdge(edge, bridge)) &&
              !wouldLoop(edges, bridge.from, bridge.to)
            ) {
              edges.push(bridge);
            }
          }
        }
      }
      const selection =
        state.selection.kind === "step" && state.selection.id === stepId
          ? ({ kind: "none" } as const)
          : state.selection;
      edit({
        ...state,
        steps: state.steps.filter((step) => step.id !== stepId),
        edges,
        selection,
      });
    },
    connect(from, to, branch) {
      const source = state.steps.find((step) => step.id === from);
      if (closed || !source || !state.steps.some((step) => step.id === to)) {
        return "not_found";
      }
      if (from === to) {
        return "self";
      }
      if (source.kind === "condition" && !branch) {
        return "branch_required";
      }
      const edgeBranch = source.kind === "condition" ? branch : undefined;
      if (
        state.edges.some(
          (edge) => edge.from === from && edge.to === to && edge.branch === edgeBranch,
        )
      ) {
        return "duplicate";
      }
      if (wouldLoop(state.edges, from, to)) {
        return "loop";
      }
      edit({
        ...state,
        edges: [...state.edges, { from, to, ...(edgeBranch ? { branch: edgeBranch } : {}) }],
      });
      return null;
    },
    disconnect(target) {
      edit({ ...state, edges: state.edges.filter((edge) => !sameEdge(edge, target)) });
    },
    updateAgentStep(stepId, patch) {
      edit({
        ...state,
        steps: mapStep(stepId, (step) => (step.kind === "agent" ? { ...step, ...patch } : step)),
      });
    },
    setStepModel(stepId, provider, modelId) {
      edit({
        ...state,
        steps: mapStep(stepId, (step) => {
          if (step.kind !== "agent") {
            return step;
          }
          if (!provider) {
            return { ...step, provider: null, model: "", modeId: "", thinkingOptionId: "" };
          }
          const model = pickModel(provider, modelId);
          const thinkingOptionId = pickThinking(provider, model, state.providerEntries);
          if (model && thinkingOptionId) {
            thinkingDrafts.set(`${provider}:${model}`, thinkingOptionId);
          }
          return {
            ...step,
            provider,
            model,
            modeId: step.provider === provider ? step.modeId : "",
            thinkingOptionId,
          };
        }),
      });
    },
    setStepThinking(stepId, thinkingOptionId) {
      edit({
        ...state,
        steps: mapStep(stepId, (step) => {
          if (step.kind !== "agent" || !step.provider) {
            return step;
          }
          if (step.model) {
            thinkingDrafts.set(`${step.provider}:${step.model}`, thinkingOptionId);
          }
          return { ...step, thinkingOptionId };
        }),
      });
    },
    setStepMode(stepId, modeId) {
      edit({
        ...state,
        steps: mapStep(stepId, (step) =>
          step.kind === "agent" && step.provider ? { ...step, modeId } : step,
        ),
      });
    },
    updateCheckStep(stepId, patch) {
      edit({
        ...state,
        steps: mapStep(stepId, (step) =>
          step.kind === "condition" ? { ...step, ...patch } : step,
        ),
      });
    },
    markSaved() {
      savedEdits = edits;
      publish({ ...state, submitError: null });
    },
    setSubmitError(value) {
      publish({ ...state, submitError: value });
    },
  };
}
