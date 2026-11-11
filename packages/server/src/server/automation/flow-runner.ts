import type {
  Automation,
  AutomationAgentNode,
  AutomationNode,
  AutomationPullRequestEvent,
  AutomationRun,
  AutomationRunStatus,
  AutomationRunStep,
} from "@pimi/protocol/automation/types";
import {
  evaluateAutomationCondition,
  renderAutomationTemplate,
  topologicalOrder,
} from "@pimi/protocol/automation/validate";
import {
  type AutomationEngineDeps,
  type RunHandle,
  type RunWorkspace,
  type StepHandle,
  RunStoppedError,
  openRunWorkspace,
  runAgentStep,
  runTitle,
} from "./engine.js";

// Steps of one run that may have an agent working at the same time.
const MAX_PARALLEL_STEPS = 3;

export type StepPatch = Partial<Omit<AutomationRunStep, "nodeId">>;

export interface FlowRunResult {
  status: Exclude<AutomationRunStatus, "running">;
  error: string | null;
  reportAgentId: string | null;
}

interface FlowRunInput {
  automation: Automation;
  run: AutomationRun;
  handle: RunHandle;
  pullRequest: AutomationPullRequestEvent | null;
  // Writes one step's change to the run record. Called one change at a time per step.
  updateStep: (nodeId: string, patch: StepPatch) => Promise<void>;
  onWorkspace: (workspace: RunWorkspace) => Promise<void>;
}

type Terminal = "succeeded" | "failed" | "cancelled" | "skipped";

interface NodeState {
  status: "pending" | "running" | Terminal;
  output: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function now(): string {
  return new Date().toISOString();
}

// Runs a run's steps in dependency order. A step starts when every step before it has finished.
// It runs when at least one incoming edge is live (its source succeeded and, for a condition, the
// edge's branch matches), and is skipped when none is. A failed or cancelled step skips what
// depends on it; independent branches keep going. Steps the run record already marks succeeded
// (a retry's reused steps) are not run again.
export async function runFlow(
  deps: AutomationEngineDeps,
  input: FlowRunInput,
): Promise<FlowRunResult> {
  const { automation, run, handle } = input;
  const flow = automation.flow;
  const order = topologicalOrder(flow);
  if (!order) {
    throw new Error("The flow has a loop");
  }
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
  let firstFailure: { nodeId: string; message: string } | null = null;
  let reportAgentId: string | null = run.reportAgentId;

  function acquireWorkspace(node: AutomationAgentNode, prompt: string): Promise<RunWorkspace> {
    let workspace = workspaces.get(node.workspace);
    if (!workspace) {
      workspace = openRunWorkspace(deps, {
        automation,
        title: runTitle(automation, run),
        kind: node.workspace,
        prompt,
      }).then(async (opened) => {
        await input.onWorkspace(opened);
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
    return { steps, pullRequest: input.pullRequest };
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

  // What a pending node should do now that some of its sources may have finished.
  function readiness(node: AutomationNode): "wait" | "run" | { skip: string | null } {
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

  async function runAgentNode(node: AutomationAgentNode): Promise<void> {
    const stepHandle: StepHandle = { agentId: null, stopReason: handle.stopReason };
    handle.steps.add(stepHandle);
    try {
      const prompt = renderAutomationTemplate(node.prompt, renderContext());
      const workspace = await acquireWorkspace(node, prompt);
      await input.updateStep(node.id, {
        workspaceId: workspace.workspaceId,
        createdWorktree: workspace.createdWorktree,
      });
      const result = await runAgentStep(deps, {
        automation,
        run,
        node,
        prompt,
        workspace,
        handle: stepHandle,
        onAgent: async (agentId, modeId) => {
          reportAgentId = agentId;
          await input.updateStep(node.id, { agentId, modeId });
        },
      });
      await finish(node.id, { status: "succeeded", output: result.output }, { error: null });
    } catch (error) {
      if (error instanceof RunStoppedError && error.reason === "cancelled") {
        await finish(node.id, { status: "cancelled", output: null }, { error: null });
        return;
      }
      const message = errorMessage(error);
      firstFailure ??= { nodeId: node.id, message };
      await finish(node.id, { status: "failed", output: null }, { error: message });
    } finally {
      handle.steps.delete(stepHandle);
    }
  }

  async function startNode(node: AutomationNode): Promise<void> {
    states.set(node.id, { status: "running", output: null });
    await input.updateStep(node.id, { status: "running", startedAt: now(), error: null });
    if (node.kind === "condition") {
      try {
        const subject = renderAutomationTemplate(node.input, renderContext());
        const result = evaluateAutomationCondition(node, subject) ? "true" : "false";
        await finish(node.id, { status: "succeeded", output: result }, { error: null });
      } catch (error) {
        const message = errorMessage(error);
        firstFailure ??= { nodeId: node.id, message };
        await finish(node.id, { status: "failed", output: null }, { error: message });
      }
      return;
    }
    const task = runAgentNode(node).finally(() => running.delete(node.id));
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
      const next = readiness(node);
      if (next === "wait") {
        continue;
      }
      if (next !== "run") {
        await finish(id, { status: "skipped", output: null }, { error: next.skip });
        progressed = true;
        continue;
      }
      if (node.kind === "agent" && running.size >= MAX_PARALLEL_STEPS) {
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

  const failure = firstFailure as { nodeId: string; message: string } | null;
  return {
    ...summarizeFlow({
      stopReason: handle.stopReason,
      failure: failure
        ? { title: nodes.get(failure.nodeId)?.title || failure.nodeId, message: failure.message }
        : null,
      anyCancelled: [...states.values()].some((state) => state.status === "cancelled"),
    }),
    reportAgentId,
  };
}

function summarizeFlow(input: {
  stopReason: RunHandle["stopReason"];
  failure: { title: string; message: string } | null;
  anyCancelled: boolean;
}): Omit<FlowRunResult, "reportAgentId"> {
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
