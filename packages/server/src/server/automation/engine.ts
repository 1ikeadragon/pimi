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
import type { CreatePaseoWorktreeWorkflowResult } from "../worktree-session.js";

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
  }) => Promise<CreatePaseoWorktreeWorkflowResult>;
  archiveWorkspace: (workspaceId: string) => Promise<void>;
}

export type RunStopReason = "cancelled" | "timed_out" | "permission";

// Live state of one running run, shared between the step and whoever stops it.
export interface RunHandle {
  agentId: string | null;
  stopReason: RunStopReason | null;
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

export interface AgentStepCallbacks {
  onWorkspace: (workspaceId: string) => Promise<void>;
  onAgent: (agentId: string, modeId: string | null) => Promise<void>;
}

export function summarizeRunCause(run: AutomationRun): string {
  if (run.cause.kind === "manual") {
    return "manual run";
  }
  return new Date(run.cause.event.scheduledFor).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function capOutput(text: string | null | undefined): string | null {
  const trimmed = text?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.length > STEP_OUTPUT_LIMIT ? `${trimmed.slice(0, STEP_OUTPUT_LIMIT)}…` : trimmed;
}

async function assertProjectDirectory(cwd: string): Promise<void> {
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

// Runs one agent node: opens its workspace, starts an unattended agent with the node's
// prompt, and waits for the turn. The workspace is kept once the agent exists, because its
// chat is the run's report.
export async function runAgentStep(
  deps: AutomationEngineDeps,
  input: {
    automation: Automation;
    run: AutomationRun;
    node: AutomationAgentNode;
    handle: RunHandle;
    callbacks: AgentStepCallbacks;
  },
): Promise<{ output: string | null }> {
  const { automation, run, node, handle, callbacks } = input;
  await assertProjectDirectory(automation.project.cwd);
  const title = `${automation.name} · ${summarizeRunCause(run)}`;
  const workspace =
    node.workspace === "worktree"
      ? (
          await deps.createWorktreeWorkspace({
            cwd: automation.project.cwd,
            firstAgentContext: { prompt: node.prompt },
          })
        ).workspace
      : await deps.createDirectoryWorkspace({ cwd: automation.project.cwd, title });
  await callbacks.onWorkspace(workspace.workspaceId);

  let agentId: string | null = null;
  try {
    if (handle.stopReason) {
      throw new RunStoppedError(handle.stopReason);
    }
    const created = await deps.createAgent({
      kind: "mcp",
      provider: formatProviderModel(node.provider, node.model),
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
        "paseo.automation-id": automation.id,
        "paseo.automation-run": run.id,
        "paseo.automation-node": node.id,
      },
      mode: node.modeId,
      thinking: node.thinkingOptionId,
      features: node.featureValues,
      unattended: true,
      promptFailure: "return-error",
      notifyOnFinish: false,
    });
    agentId = created.snapshot.id;
    handle.agentId = agentId;
    await callbacks.onAgent(agentId, created.snapshot.currentModeId ?? null);
    if (created.initialPromptError) {
      throw created.initialPromptError;
    }
    if (handle.stopReason) {
      throw new RunStoppedError(handle.stopReason);
    }
    const turnAgentId = agentId;
    const permissionWatch = new AbortController();
    void waitForPermissionPrompt(deps.agentManager, turnAgentId, permissionWatch.signal)
      .then(async () => {
        if (!handle.stopReason) {
          handle.stopReason = "permission";
          await deps.agentManager.cancelAgentRun(turnAgentId);
        }
        return undefined;
      })
      .catch((error: unknown) => {
        if (!permissionWatch.signal.aborted) {
          deps.logger.warn(
            { err: error, automationId: automation.id, runId: run.id },
            "Failed to watch automation agent for permission prompts",
          );
        }
      });
    let result: Awaited<ReturnType<AutomationEngineAgentManager["runAgent"]>>;
    try {
      result = await deps.agentManager.runAgent(turnAgentId, node.prompt);
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
  } finally {
    if (agentId === null) {
      await deps.archiveWorkspace(workspace.workspaceId).catch((error: unknown) => {
        deps.logger.warn(
          { err: error, automationId: automation.id, runId: run.id },
          "Failed to archive automation workspace after the agent could not start",
        );
      });
    }
  }
}
