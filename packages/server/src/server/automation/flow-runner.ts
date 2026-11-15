import type {
  AutomationAgentNode,
  AutomationFlow,
  AutomationGateNode,
  AutomationGateVerdict,
  AutomationNode,
  AutomationPullRequestEvent,
  AutomationRunStatus,
  AutomationRunStep,
} from "@pimi/protocol/automation/types";
import {
  downstreamNodeIds,
  evaluateAutomationCondition,
  renderAutomationTemplate,
  topologicalOrder,
  upstreamNodeIds,
} from "@pimi/protocol/automation/validate";
import {
  type AutomationEngineDeps,
  type RunHandle,
  type RunStopReason,
  type RunSubject,
  type RunWorkspace,
  type StepHandle,
  RunStoppedError,
  buildGatePrompt,
  runAgentStep,
  runGateStep,
} from "./engine.js";

// Steps of one run that may have an agent working at the same time.
const MAX_PARALLEL_STEPS = 3;

export type StepPatch = Partial<Omit<AutomationRunStep, "nodeId">>;

export interface FlowRunResult {
  status: Exclude<AutomationRunStatus, "running">;
  error: string | null;
  reportAgentId: string | null;
  // True when the run failed only because a gate ran out of attempts.
  notMet: boolean;
  // The output of the last agent step that succeeded, in dependency order.
  output: string | null;
}

interface FlowRunInput {
  subject: RunSubject;
  run: { id: string; steps: readonly AutomationRunStep[]; reportAgentId?: string | null };
  handle: RunHandle;
  pullRequest: AutomationPullRequestEvent | null;
  // What the chat passed to a saved flow; read as `{{input}}`.
  input?: string | null;
  // Agents are titled "<step> · <runTitle>" and carry `agentLabels`.
  runTitle: string;
  agentLabels: Record<string, string>;
  // Where an agent node's step runs. Called once per workspace kind and cached for the run.
  openWorkspace: (node: AutomationAgentNode, prompt: string) => Promise<RunWorkspace>;
  // Writes one step's change to the run record. Called one change at a time per step.
  updateStep: (nodeId: string, patch: StepPatch) => Promise<void>;
  onWorkspace?: (workspace: RunWorkspace) => Promise<void>;
}

type Terminal = "succeeded" | "failed" | "cancelled" | "skipped";

interface NodeState {
  status: "pending" | "running" | Terminal;
  output: string | null;
}

interface Failure {
  nodeId: string;
  message: string;
  gate: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function now(): string {
  return new Date().toISOString();
}

export function gateFailureMessage(title: string, feedback: string): string {
  return `Check '${title}' failed: ${feedback}. Fix it and report again.`;
}

// What a pending node should do now that some of its sources may have finished.
function readiness(
  flow: AutomationFlow,
  nodes: ReadonlyMap<string, AutomationNode>,
  states: ReadonlyMap<string, NodeState>,
  node: AutomationNode,
): "wait" | "run" | { skip: string | null } {
  const incoming = flow.edges.filter((edge) => edge.to === node.id);
  let live = false;
  for (const edge of incoming) {
    const source = states.get(edge.from)!;
    if (source.status === "pending" || source.status === "running") {
      return "wait";
    }
  }
  for (const edge of incoming) {
    const source = states.get(edge.from)!;
    if (source.status === "failed" || source.status === "cancelled") {
      const title = nodes.get(edge.from)?.title || edge.from;
      return { skip: `Not run: ${title} did not finish` };
    }
    if (source.status !== "succeeded") {
      continue;
    }
    const sourceNode = nodes.get(edge.from)!;
    if (sourceNode.kind !== "condition" || edge.branch === source.output) {
      live = true;
    }
  }
  if (incoming.length > 0 && !live) {
    return { skip: null };
  }
  return "run";
}

// The judge takes the model settings of the step it checks, so it runs with the permissions the
// owner already gave that step's agent; it never takes the step's profile or prompt.
function judgeSettings(
  flow: AutomationFlow,
  nodes: ReadonlyMap<string, AutomationNode>,
  order: readonly string[],
  gate: AutomationGateNode,
): AutomationAgentNode | null {
  const retry = nodes.get(gate.retryFrom);
  if (retry?.kind === "agent") {
    return retry;
  }
  const upstream = upstreamNodeIds(flow, gate.id);
  for (const id of order.toReversed()) {
    const candidate = nodes.get(id);
    if (upstream.has(id) && candidate?.kind === "agent") {
      return candidate;
    }
  }
  return null;
}

// The output of the last agent step that succeeded, in dependency order.
function lastAgentOutput(
  nodes: ReadonlyMap<string, AutomationNode>,
  states: ReadonlyMap<string, NodeState>,
  order: readonly string[],
): string | null {
  for (const id of order.toReversed()) {
    const state = states.get(id)!;
    if (nodes.get(id)?.kind === "agent" && state.status === "succeeded" && state.output) {
      return state.output;
    }
  }
  return null;
}

// Runs a run's steps in dependency order. A step starts when every step before it has finished.
// It runs when at least one incoming edge is live (its source succeeded and, for a condition, the
// edge's branch matches), and is skipped when none is. A failed or cancelled step skips what
// depends on it; independent branches keep going. Steps the run record already marks succeeded
// (a retry's reused steps) are not run again.
//
// A gate that fails with attempts left sends the run back: the steps from its `retryFrom` down to
// the gate go back to pending, and the step agents that already ran get the judge's feedback as
// their next message. A gate out of attempts fails, which skips everything after it.
export async function runFlow(
  deps: AutomationEngineDeps,
  input: FlowRunInput,
): Promise<FlowRunResult> {
  const { subject, run, handle } = input;
  const flow = subject.flow;
  const sorted = topologicalOrder(flow);
  if (!sorted) {
    throw new Error("The flow has a loop");
  }
  const order: string[] = sorted;
  const nodes = new Map(flow.nodes.map((node) => [node.id, node]));
  const states = new Map<string, NodeState>();
  for (const node of flow.nodes) {
    const recorded = run.steps.find((step) => step.nodeId === node.id);
    states.set(
      node.id,
      recorded?.status === "succeeded"
        ? { status: "succeeded", output: recorded.output }
        : { status: "pending", output: null },
    );
  }
  const workspaces = new Map<AutomationAgentNode["workspace"], Promise<RunWorkspace>>();
  const running = new Map<string, Promise<void>>();
  const agentIds = new Map<string, string>();
  const agentAttempts = new Map<string, number>();
  const retryMessages = new Map<string, string>();
  const gateVerdicts = new Map<string, AutomationGateVerdict[]>();
  let firstFailure: Failure | null = null;
  let reportAgentId: string | null = run.reportAgentId ?? null;

  function acquireWorkspace(node: AutomationAgentNode, prompt: string): Promise<RunWorkspace> {
    let workspace = workspaces.get(node.workspace);
    if (!workspace) {
      workspace = input.openWorkspace(node, prompt).then(async (opened) => {
        await input.onWorkspace?.(opened);
        return opened;
      });
      // A failed open is retried by the next step that needs the workspace.
      workspace.catch(() => workspaces.delete(node.workspace));
      workspaces.set(node.workspace, workspace);
    }
    return workspace;
  }

  function renderContext() {
    const steps = new Map<string, string | null>();
    for (const [id, state] of states) {
      if (state.status === "succeeded" || state.status === "skipped") {
        steps.set(id, state.output);
      }
    }
    return { steps, pullRequest: input.pullRequest, input: input.input ?? null };
  }

  async function finish(nodeId: string, state: NodeState & { status: Terminal }, patch: StepPatch) {
    states.set(nodeId, state);
    await input.updateStep(nodeId, {
      status: state.status,
      output: state.output,
      endedAt: now(),
      ...patch,
    });
  }

  function stepTitle(node: AutomationNode): string {
    return `${node.title || node.id} · ${input.runTitle}`;
  }

  function baseStep(node: AutomationNode, handleForStep: StepHandle) {
    return {
      subjectId: subject.id,
      runId: run.id,
      nodeId: node.id,
      title: stepTitle(node),
      labels: { ...input.agentLabels, "pimi.automation-node": node.id },
      handle: handleForStep,
    };
  }

  async function failNode(node: AutomationNode, message: string, patch: StepPatch = {}) {
    firstFailure ??= { nodeId: node.id, message, gate: false };
    await finish(node.id, { status: "failed", output: null }, { error: message, ...patch });
  }

  async function runAgentNode(node: AutomationAgentNode): Promise<void> {
    const stepHandle: StepHandle = { agentId: null, stopReason: handle.stopReason };
    handle.steps.add(stepHandle);
    const attempt = (agentAttempts.get(node.id) ?? 0) + 1;
    agentAttempts.set(node.id, attempt);
    try {
      const resumeAgentId = agentIds.get(node.id);
      const retryMessage = retryMessages.get(node.id);
      retryMessages.delete(node.id);
      const prompt =
        resumeAgentId && retryMessage
          ? retryMessage
          : renderAutomationTemplate(node.prompt, renderContext());
      const workspace = await acquireWorkspace(node, prompt);
      await input.updateStep(node.id, {
        workspaceId: workspace.workspaceId,
        createdWorktree: workspace.createdWorktree,
        attempt,
      });
      const result = await runAgentStep(deps, {
        ...baseStep(node, stepHandle),
        node,
        prompt,
        workspace,
        resumeAgentId: resumeAgentId && retryMessage ? resumeAgentId : undefined,
        onAgent: async (agentId, modeId) => {
          reportAgentId = agentId;
          agentIds.set(node.id, agentId);
          await input.updateStep(node.id, { agentId, modeId });
        },
      });
      await finish(node.id, { status: "succeeded", output: result.output }, { error: null });
    } catch (error) {
      if (error instanceof RunStoppedError && error.reason === "cancelled") {
        await finish(node.id, { status: "cancelled", output: null }, { error: null });
        return;
      }
      await failNode(node, errorMessage(error));
    } finally {
      handle.steps.delete(stepHandle);
    }
  }

  // Sends the run back: the steps from the gate's `retryFrom` down to the gate go back to
  // pending, and the agents of those that ran get the feedback as their next message.
  async function sendBack(gate: AutomationGateNode, feedback: string) {
    const redo = new Set([gate.retryFrom]);
    const upstream = upstreamNodeIds(flow, gate.id);
    for (const id of downstreamNodeIds(flow, gate.retryFrom)) {
      if (upstream.has(id)) {
        redo.add(id);
      }
    }
    const message = gateFailureMessage(gate.title || gate.id, feedback);
    for (const id of redo) {
      const node = nodes.get(id)!;
      states.set(id, { status: "pending", output: null });
      if (node.kind === "agent") {
        retryMessages.set(id, message);
      }
      await input.updateStep(id, {
        status: "pending",
        output: null,
        error: null,
        endedAt: null,
      });
    }
  }

  async function runGateNode(node: AutomationGateNode): Promise<void> {
    const stepHandle: StepHandle = { agentId: null, stopReason: handle.stopReason };
    handle.steps.add(stepHandle);
    try {
      const settings = judgeSettings(flow, nodes, order, node);
      if (!settings) {
        await failNode(node, "A gate needs an agent step before it to take its model from");
        return;
      }
      const previous = gateVerdicts.get(node.id) ?? [];
      const attempt = previous.length + 1;
      const workspace = await acquireWorkspace(settings, node.criteria);
      await input.updateStep(node.id, {
        workspaceId: workspace.workspaceId,
        createdWorktree: workspace.createdWorktree,
        attempt,
      });
      const verdict = await runGateStep(deps, {
        ...baseStep(node, stepHandle),
        prompt: buildGatePrompt({
          gate: node,
          criteria: renderAutomationTemplate(node.criteria, renderContext()),
          attempt,
          previous,
        }),
        agent: settings,
        workspace,
        onAgent: async (agentId, modeId) => {
          await input.updateStep(node.id, { agentId, modeId });
        },
      });
      const verdicts = [...previous, { ...verdict, at: now() }];
      gateVerdicts.set(node.id, verdicts);
      if (verdict.pass) {
        await finish(
          node.id,
          { status: "succeeded", output: verdict.feedback || "pass" },
          { error: null, attempt, verdicts },
        );
        return;
      }
      if (attempt < node.maxAttempts) {
        await sendBack(node, verdict.feedback);
        states.set(node.id, { status: "pending", output: null });
        await input.updateStep(node.id, {
          status: "pending",
          output: null,
          error: null,
          endedAt: null,
          attempt,
          verdicts,
        });
        return;
      }
      firstFailure ??= {
        nodeId: node.id,
        message: `Not met after ${attempt} ${attempt === 1 ? "attempt" : "attempts"}: ${verdict.feedback}`,
        gate: true,
      };
      await finish(
        node.id,
        { status: "failed", output: null },
        { error: verdict.feedback, attempt, verdicts },
      );
    } catch (error) {
      if (error instanceof RunStoppedError && error.reason === "cancelled") {
        await finish(node.id, { status: "cancelled", output: null }, { error: null });
        return;
      }
      await failNode(node, errorMessage(error));
    } finally {
      handle.steps.delete(stepHandle);
    }
  }

  async function startNode(node: AutomationNode): Promise<void> {
    states.set(node.id, { status: "running", output: null });
    await input.updateStep(node.id, { status: "running", startedAt: now(), error: null });
    if (node.kind === "condition") {
      try {
        const subjectText = renderAutomationTemplate(node.input, renderContext());
        const result = evaluateAutomationCondition(node, subjectText) ? "true" : "false";
        await finish(node.id, { status: "succeeded", output: result }, { error: null });
      } catch (error) {
        await failNode(node, errorMessage(error));
      }
      return;
    }
    const task = (node.kind === "gate" ? runGateNode(node) : runAgentNode(node)).finally(() =>
      running.delete(node.id),
    );
    running.set(node.id, task);
  }

  for (;;) {
    let progressed = false;
    for (const id of order) {
      const state = states.get(id)!;
      if (state.status !== "pending") {
        continue;
      }
      if (handle.stopReason) {
        await finish(id, { status: "cancelled", output: null }, { error: null });
        progressed = true;
        continue;
      }
      const node = nodes.get(id)!;
      const next = readiness(flow, nodes, states, node);
      if (next === "wait") {
        continue;
      }
      if (next !== "run") {
        await finish(id, { status: "skipped", output: null }, { error: next.skip });
        progressed = true;
        continue;
      }
      if (node.kind !== "condition" && running.size >= MAX_PARALLEL_STEPS) {
        continue;
      }
      await startNode(node);
      progressed = true;
    }
    if (progressed) {
      continue;
    }
    if (running.size === 0) {
      break;
    }
    await Promise.race(running.values());
  }

  const failure = firstFailure as Failure | null;
  const output = lastAgentOutput(nodes, states, order);
  return {
    ...summarizeFlow({
      stopReason: handle.stopReason,
      failure: failure
        ? { title: nodes.get(failure.nodeId)?.title || failure.nodeId, message: failure.message }
        : null,
      anyCancelled: [...states.values()].some((state) => state.status === "cancelled"),
    }),
    reportAgentId,
    notMet: failure?.gate === true,
    output,
  };
}

function summarizeFlow(input: {
  stopReason: RunStopReason | null;
  failure: { title: string; message: string } | null;
  anyCancelled: boolean;
}): Pick<FlowRunResult, "status" | "error"> {
  if (input.stopReason === "timed_out") {
    return { status: "failed", error: new RunStoppedError("timed_out").message };
  }
  if (input.failure) {
    return { status: "failed", error: `${input.failure.title}: ${input.failure.message}` };
  }
  if (input.stopReason === "cancelled" || input.anyCancelled) {
    return { status: "cancelled", error: null };
  }
  return { status: "succeeded", error: null };
}
