import { stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import type {
  Automation,
  AutomationAgentNode,
  AutomationRun,
} from "@pimi/protocol/automation/types";
import type { FirstAgentContext } from "@pimi/protocol/messages";
import type { AgentManager } from "../agent/agent-manager.js";
import { curateAgentActivity } from "../agent/activity-curator.js";
import { type BoundCreateAgentCommand, formatProviderModel } from "../agent/create-agent/create.js";
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
    automation: Automation;
    title: string;
    kind: AutomationAgentNode["workspace"];
    prompt: string;
  },
): Promise<RunWorkspace> {
  const { automation } = input;
  await assertProjectDirectory(automation.project.cwd);
  if (input.kind === "worktree") {
    const { workspace } = await deps.createWorktreeWorkspace({
      cwd: automation.project.cwd,
      firstAgentContext: { prompt: input.prompt },
    });
    return { workspaceId: workspace.workspaceId, cwd: workspace.cwd, createdWorktree: true };
  }
  const workspace = await deps.createDirectoryWorkspace({
    cwd: automation.project.cwd,
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

// Runs one agent node in the run's workspace: starts an unattended agent with the step's
// rendered prompt and waits for the turn. Its chat stays in the workspace as the step's report.
export async function runAgentStep(
  deps: AutomationEngineDeps,
  input: {
    automation: Automation;
    run: AutomationRun;
    node: AutomationAgentNode;
    prompt: string;
    workspace: RunWorkspace;
    handle: StepHandle;
    onAgent: (agentId: string, modeId: string | null) => Promise<void>;
  },
): Promise<{ output: string | null }> {
  const { automation, run, node, workspace, handle } = input;
  const title = `${node.title || node.id} · ${runTitle(automation, run)}`;
  if (handle.stopReason) {
    throw new RunStoppedError(handle.stopReason);
  }
  const created = await deps.createAgent({
    kind: "mcp",
    provider: formatProviderModel(node.provider, node.model),
    // Read when the step starts, so a run uses the profile as it is now.
    profile: node.profileId,
    config: {
      provider: node.provider,
      cwd: workspace.cwd,
      model: node.model,
      modeId: node.modeId,
      thinkingOptionId: node.thinkingOptionId,
      featureValues: node.featureValues,
      title,
    },
    cwd: workspace.cwd,
    workspaceId: workspace.workspaceId,
    title,
    labels: {
      "pimi.automation-id": automation.id,
      "pimi.automation-run": run.id,
      "pimi.automation-node": node.id,
    },
    mode: node.modeId,
    thinking: node.thinkingOptionId,
    features: node.featureValues,
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
          { err: error, automationId: automation.id, runId: run.id, nodeId: node.id },
          "Failed to watch automation agent for permission prompts",
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
