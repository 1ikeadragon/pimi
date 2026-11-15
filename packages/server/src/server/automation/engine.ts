import { stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import type {
  Automation,
  AutomationAgentNode,
  AutomationFlow,
  AutomationGateNode,
  AutomationGateVerdict,
  AutomationRun,
} from "@pimi/protocol/automation/types";
import type { FirstAgentContext } from "@pimi/protocol/messages";
import type { AgentManager } from "../agent/agent-manager.js";
import { curateAgentActivity } from "../agent/activity-curator.js";
import { type BoundCreateAgentCommand, formatProviderModel } from "../agent/create-agent/create.js";
import type { GateVerdictBoard } from "./gate-verdicts.js";
import type { PersistedWorkspaceRecord } from "../workspace-registry.js";
import type { CreatePimiWorktreeWorkflowResult } from "../worktree-session.js";

const STEP_OUTPUT_LIMIT = 24_000;
const PERMISSION_POLL_MS = 1000;

export type AutomationEngineAgentManager = Pick<
  AgentManager,
  "runAgent" | "waitForAgentEvent" | "cancelAgentRun"
>;

export interface AutomationEngineDeps {
  logger: Logger;
  agentManager: AutomationEngineAgentManager;
  createAgent: BoundCreateAgentCommand;
  createDirectoryWorkspace: (input: {
    cwd: string;
    title: string;
  }) => Promise<PersistedWorkspaceRecord>;
  createWorktreeWorkspace: (input: {
    cwd: string;
    firstAgentContext: FirstAgentContext;
  }) => Promise<CreatePimiWorktreeWorkflowResult>;
  // keepDirectory archives the workspace and its agents but leaves the directory alone: no
  // teardown commands, no removal. Pass it unless the run created the worktree.
  archiveWorkspace: (workspaceId: string, options: { keepDirectory: boolean }) => Promise<void>;
  // Where a gate's judge agent files its verdict; shared with the `submit_verdict` tool.
  verdicts: GateVerdictBoard;
}

/** What a run executes: an automation or a saved flow, reduced to what the runner reads. */
export interface RunSubject {
  id: string;
  name: string;
  cwd: string;
  flow: AutomationFlow;
}

export type RunStopReason = "cancelled" | "timed_out" | "permission";

// Live state of one running step, shared between the step and whoever stops it. A permission
// prompt stops only its own step; cancelling or timing out the run stops every step.
export interface StepHandle {
  agentId: string | null;
  stopReason: RunStopReason | null;
}

export interface RunHandle {
  stopReason: Exclude<RunStopReason, "permission"> | null;
  steps: Set<StepHandle>;
}

const STOP_MESSAGES: Record<RunStopReason, string> = {
  cancelled: "The run was cancelled",
  timed_out: "The run hit its time limit",
  permission: "The agent stopped at a permission prompt; nobody is there to answer it",
};

export class RunStoppedError extends Error {
  constructor(readonly reason: RunStopReason) {
    super(STOP_MESSAGES[reason]);
    this.name = "RunStoppedError";
  }
}

/** The workspace a run opened, and whether the run made its worktree. */
export interface RunWorkspace {
  workspaceId: string;
  cwd: string;
  createdWorktree: boolean;
}

export function summarizeRunCause(run: AutomationRun): string {
  if (run.cause.kind === "manual") {
    return "manual run";
  }
  if (run.cause.kind === "retry") {
    return "retry";
  }
  if (run.cause.event.kind === "pull_request") {
    return `PR #${run.cause.event.number}`;
  }
  return new Date(run.cause.event.scheduledFor).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function runTitle(automation: Automation, run: AutomationRun): string {
  return `${automation.name} · ${summarizeRunCause(run)}`;
}

function capOutput(text: string | null | undefined): string | null {
  const trimmed = text?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.length > STEP_OUTPUT_LIMIT ? `${trimmed.slice(0, STEP_OUTPUT_LIMIT)}…` : trimmed;
}

export async function assertProjectDirectory(cwd: string): Promise<void> {
  try {
    const info = await stat(cwd);
    if (!info.isDirectory()) {
      throw new Error(`Project ${cwd} is not a directory`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Project ${cwd} no longer exists`, { cause: error });
    }
    throw error;
  }
}

// Opens the workspace a run's steps share. Project mode opens a new workspace record on the
// project directory, which may be a checkout or worktree the user works in. Only a worktree made
// here belongs to the run.
export async function openRunWorkspace(
  deps: AutomationEngineDeps,
  input: {
    subject: Pick<RunSubject, "cwd">;
    title: string;
    kind: AutomationAgentNode["workspace"];
    prompt: string;
  },
): Promise<RunWorkspace> {
  await assertProjectDirectory(input.subject.cwd);
  if (input.kind === "worktree") {
    const { workspace } = await deps.createWorktreeWorkspace({
      cwd: input.subject.cwd,
      firstAgentContext: { prompt: input.prompt },
    });
    return { workspaceId: workspace.workspaceId, cwd: workspace.cwd, createdWorktree: true };
  }
  const workspace = await deps.createDirectoryWorkspace({
    cwd: input.subject.cwd,
    title: input.title,
  });
  return { workspaceId: workspace.workspaceId, cwd: workspace.cwd, createdWorktree: false };
}

// A turn that asks for permission stays open until someone answers, and nobody watches an
// automation run. Without this the run would sit there until its time limit, holding a
// concurrency slot. Resolves true when the agent asks; rejects when `signal` aborts.
async function waitForPermissionPrompt(
  agentManager: AutomationEngineAgentManager,
  agentId: string,
  signal: AbortSignal,
): Promise<boolean> {
  for (;;) {
    const event = await agentManager.waitForAgentEvent(agentId, { waitForActive: true, signal });
    if (event.permission) {
      return true;
    }
    await delay(PERMISSION_POLL_MS, undefined, { signal });
  }
}

export interface StepAgentInput {
  /** Names the owner of the run in logs. */
  subjectId: string;
  runId: string;
  nodeId: string;
  title: string;
  labels: Record<string, string>;
  workspace: RunWorkspace;
  handle: StepHandle;
  onAgent: (agentId: string, modeId: string | null) => Promise<void>;
}

type AgentSettings = Pick<
  AutomationAgentNode,
  "provider" | "model" | "modeId" | "thinkingOptionId" | "featureValues"
>;

// A step's agent is created unattended in the run's workspace. A flow's labels make it a child of
// the chat that ran the flow, which puts it in that chat's subagents track.
async function createStepAgent(
  deps: AutomationEngineDeps,
  input: StepAgentInput & { agent: AgentSettings; profileId?: string },
): Promise<string> {
  const { agent, workspace, handle } = input;
  if (handle.stopReason) {
    throw new RunStoppedError(handle.stopReason);
  }
  const created = await deps.createAgent({
    kind: "mcp",
    provider: formatProviderModel(agent.provider, agent.model),
    // Read when the step starts, so a run uses the profile as it is now.
    profile: input.profileId,
    config: {
      provider: agent.provider,
      cwd: workspace.cwd,
      model: agent.model,
      modeId: agent.modeId,
      thinkingOptionId: agent.thinkingOptionId,
      featureValues: agent.featureValues,
      title: input.title,
    },
    cwd: workspace.cwd,
    workspaceId: workspace.workspaceId,
    title: input.title,
    labels: input.labels,
    mode: agent.modeId,
    thinking: agent.thinkingOptionId,
    features: agent.featureValues,
    unattended: true,
    promptFailure: "return-error",
    notifyOnFinish: false,
  });
  const agentId = created.snapshot.id;
  handle.agentId = agentId;
  await input.onAgent(agentId, created.snapshot.currentModeId ?? null);
  if (created.initialPromptError) {
    throw created.initialPromptError;
  }
  if (handle.stopReason) {
    throw new RunStoppedError(handle.stopReason);
  }
  return agentId;
}

// Runs one turn of a step's agent and waits for it. A turn that asks for permission stops the
// step, because nobody is there to answer.
async function runStepTurn(
  deps: AutomationEngineDeps,
  input: Pick<StepAgentInput, "subjectId" | "runId" | "nodeId" | "handle"> & {
    agentId: string;
    prompt: string;
  },
): Promise<{ output: string | null }> {
  const { agentId, handle } = input;
  const permissionWatch = new AbortController();
  void waitForPermissionPrompt(deps.agentManager, agentId, permissionWatch.signal)
    .then(async () => {
      if (!handle.stopReason) {
        handle.stopReason = "permission";
        await deps.agentManager.cancelAgentRun(agentId);
      }
      return undefined;
    })
    .catch((error: unknown) => {
      if (!permissionWatch.signal.aborted) {
        deps.logger.warn(
          { err: error, subjectId: input.subjectId, runId: input.runId, nodeId: input.nodeId },
          "Failed to watch run agent for permission prompts",
        );
      }
    });
  let result: Awaited<ReturnType<AutomationEngineAgentManager["runAgent"]>>;
  try {
    result = await deps.agentManager.runAgent(agentId, input.prompt);
  } catch (error) {
    // A stopped turn can surface as a failed turn; report why it was stopped.
    if (handle.stopReason) {
      throw new RunStoppedError(handle.stopReason);
    }
    throw error;
  } finally {
    permissionWatch.abort();
  }
  if (result.canceled) {
    throw new RunStoppedError(handle.stopReason ?? "cancelled");
  }
  const waitResult = await deps.agentManager.waitForAgentEvent(agentId, { waitForActive: true });
  if (waitResult.permission) {
    throw new Error(`The agent stopped at a permission prompt`);
  }
  if (waitResult.status === "error") {
    throw new Error(waitResult.lastMessage ?? "The agent failed");
  }
  return {
    output: capOutput(
      waitResult.lastMessage || result.finalText || curateAgentActivity(result.timeline),
    ),
  };
}

// Runs one agent node in the run's workspace: starts an unattended agent with the step's
// rendered prompt and waits for the turn. Its chat stays in the workspace as the step's report.
// With `resumeAgentId` (a gate sent the run back) the step's existing agent gets `prompt` as its
// next message instead of a new agent being made.
export async function runAgentStep(
  deps: AutomationEngineDeps,
  input: StepAgentInput & {
    node: AutomationAgentNode;
    prompt: string;
    resumeAgentId?: string;
  },
): Promise<{ output: string | null }> {
  const { handle } = input;
  let agentId = input.resumeAgentId;
  if (agentId) {
    if (handle.stopReason) {
      throw new RunStoppedError(handle.stopReason);
    }
    handle.agentId = agentId;
  } else {
    agentId = await createStepAgent(deps, {
      ...input,
      agent: input.node,
      profileId: input.node.profileId,
    });
  }
  return runStepTurn(deps, { ...input, agentId, prompt: input.prompt });
}

export const SUBMIT_VERDICT_TOOL = "submit_verdict";

export function buildGatePrompt(input: {
  gate: AutomationGateNode;
  criteria: string;
  attempt: number;
  previous: readonly AutomationGateVerdict[];
}): string {
  const lines = [
    `You are the judge for the check "${input.gate.title || input.gate.id}". Decide whether the work in this directory meets the criteria below. You did not do the work and must not fix it.`,
    "",
    "Criteria:",
    input.criteria.trim(),
    "",
    "Inspect the real state of the directory: read files and run commands to check each criterion yourself. Do not trust what any step reported.",
    `When you have decided, call the ${SUBMIT_VERDICT_TOOL} tool exactly once with pass set to true or false and feedback. When it fails, feedback must say what is wrong and what has to change, in terms the author can act on. Prose is not read: no ${SUBMIT_VERDICT_TOOL} call counts as a fail.`,
  ];
  if (input.previous.length > 0) {
    const earlier = input.previous
      .map(
        (verdict, index) => `#${index + 1} ${verdict.pass ? "pass" : "fail"}: ${verdict.feedback}`,
      )
      .join(" | ");
    lines.push("", `This is attempt ${input.attempt}. Earlier verdicts: ${earlier}`);
  }
  return lines.join("\n");
}

// Runs a gate's judge: a fresh agent in the run's directory that inspects the work and files its
// verdict with the run-scoped `submit_verdict` tool. A turn that ends without a verdict is a fail.
// Stopping the run (cancelled, timed out) throws; every other way the judge can go wrong is a
// fail verdict, because a gate that cannot be checked must not let the run through.
export async function runGateStep(
  deps: AutomationEngineDeps,
  input: StepAgentInput & {
    prompt: string;
    agent: AgentSettings;
  },
): Promise<{ pass: boolean; feedback: string }> {
  let agentId: string | null = null;
  try {
    agentId = await createStepAgent(deps, { ...input, agent: input.agent });
    deps.verdicts.open(agentId);
    await runStepTurn(deps, { ...input, agentId });
  } catch (error) {
    if (error instanceof RunStoppedError && error.reason !== "permission") {
      throw error;
    }
    if (agentId) {
      deps.verdicts.discard(agentId);
    }
    return {
      pass: false,
      feedback: `The judge could not finish: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const verdict = deps.verdicts.take(agentId);
  if (!verdict) {
    return { pass: false, feedback: `The judge ended without calling ${SUBMIT_VERDICT_TOOL}.` };
  }
  return verdict;
}
