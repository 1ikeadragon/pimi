import { randomBytes } from "node:crypto";
import type { Logger } from "pino";
import { PARENT_AGENT_ID_LABEL } from "@pimi/protocol/agent-labels";
import type { AgentProfile } from "@pimi/protocol/agent-profile";
import { topologicalOrder } from "@pimi/protocol/automation/validate";
import type { FlowDefinition, FlowOrigin, Flow, FlowRun } from "@pimi/protocol/flow/types";
import { validateFlowDefinition } from "@pimi/protocol/flow/validate";
import { formatSystemNotificationPrompt } from "../agent/agent-messages/index.js";
import { ensureAgentLoaded } from "../agent/agent-loading.js";
import type { AgentManager } from "../agent/agent-manager.js";
import { startAgentRun } from "../agent/agent-prompt.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { type AutomationEngineDeps, type RunHandle } from "../automation/engine.js";
import { runFlow, type FlowRunResult, type StepPatch } from "../automation/flow-runner.js";
import type {
  GateVerdict,
  GateVerdictBoard,
  SubmitVerdictOutcome,
} from "../automation/gate-verdicts.js";
import { normalizeFlowProfiles, pendingStep } from "../automation/service.js";
import type { PimiDatabase } from "../db/pimi-db.js";
import { FlowStore } from "./store.js";

// A run that is still going after this long is stopped.
const MAX_RUN_RUNTIME_MS = 2 * 60 * 60_000;
// Runs that may work at the same time on this host.
const MAX_ACTIVE_RUNS = 4;
const MAX_DESCRIPTION_LENGTH = 400;

export class FlowNotFoundError extends Error {
  constructor(what: string) {
    super(`Flow not found: ${what}`);
    this.name = "FlowNotFoundError";
  }
}

export class FlowStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowStateError";
  }
}

export interface FlowServiceOptions extends Omit<AutomationEngineDeps, "logger" | "agentManager"> {
  database: PimiDatabase;
  logger: Logger;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  getAgentProfiles: () => readonly AgentProfile[];
}

interface ActiveRun {
  handle: RunHandle;
  agentId: string;
}

function now(): string {
  return new Date().toISOString();
}

function failUnfinishedStep(step: FlowRun["steps"][number]): FlowRun["steps"][number] {
  if (step.status !== "running" && step.status !== "pending") return step;
  return { ...step, status: "failed", endedAt: now(), error: "The daemon restarted" };
}

// What the chat is told when a run ends. Not met carries the judge's last feedback, so the agent
// can tell the user why the outcome never ran.
function describeFinishedRun(run: FlowRun): string {
  const head = `Flow "${run.flowName}" (run ${run.id})`;
  if (run.status === "succeeded") {
    return `${head} finished. Final output:\n${run.output ?? "(the last step wrote nothing)"}`;
  }
  if (run.status === "not_met") {
    return `${head} ended Not met: a check failed on every attempt, so the outcome did not run. Last feedback:\n${run.output ?? ""}`;
  }
  return `${head} failed: ${run.error ?? "unknown error"}`;
}

// Saved graphs of agent steps and judge gates, run only from a chat. A run's step and judge
// agents are children of that chat in its workspace; the result comes back to the chat as a
// message. An agent's flow does not run until the owner approves it.
export class FlowService {
  private readonly logger: Logger;
  private readonly store: FlowStore;
  private readonly engine: AutomationEngineDeps;
  private readonly agentManager: AgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly getAgentProfiles: () => readonly AgentProfile[];
  private readonly verdicts: GateVerdictBoard;
  private readonly active = new Map<string, ActiveRun>();

  constructor(options: FlowServiceOptions) {
    this.logger = options.logger.child({ module: "flow-service" });
    this.store = new FlowStore({ database: options.database, logger: this.logger });
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.getAgentProfiles = options.getAgentProfiles;
    this.verdicts = options.verdicts;
    this.engine = {
      logger: this.logger,
      agentManager: options.agentManager,
      createAgent: options.createAgent,
      createDirectoryWorkspace: options.createDirectoryWorkspace,
      createWorktreeWorkspace: options.createWorktreeWorkspace,
      archiveWorkspace: options.archiveWorkspace,
      verdicts: options.verdicts,
    };
  }

  // A run the daemon stopped under cannot continue: its agents are gone from memory.
  async start(): Promise<void> {
    for (const run of await this.store.runs.list()) {
      if (run.status !== "running") continue;
      await this.store.runs.put({
        ...run,
        status: "failed",
        endedAt: now(),
        error: "The daemon restarted while this run was running",
        steps: run.steps.map(failUnfinishedStep),
      });
    }
  }

  async stop(): Promise<void> {
    for (const runId of this.active.keys()) this.stopRun(runId);
  }

  submitVerdict(agentId: string, verdict: GateVerdict): SubmitVerdictOutcome {
    return this.verdicts.submit(agentId, verdict);
  }

  async list(): Promise<Flow[]> {
    const flows = await this.store.flows.list();
    return flows.sort((left, right) => left.name.localeCompare(right.name));
  }

  async get(id: string): Promise<Flow> {
    const flow = await this.store.flows.get(id);
    if (!flow) throw new FlowNotFoundError(id);
    return flow;
  }

  async getByName(name: string): Promise<Flow> {
    const wanted = name.trim().replace(/^\//, "").toLowerCase();
    const flow = (await this.store.flows.list()).find((candidate) => candidate.name === wanted);
    if (!flow) throw new FlowNotFoundError(name);
    return flow;
  }

  private normalize(definition: FlowDefinition): FlowDefinition {
    const normalized: FlowDefinition = {
      name: definition.name.trim(),
      description: definition.description.trim(),
      flow: normalizeFlowProfiles(definition.flow, this.getAgentProfiles()),
    };
    const hint = definition.argumentHint?.trim();
    if (hint) normalized.argumentHint = hint;
    const issues = validateFlowDefinition(normalized);
    if (issues.length > 0) {
      throw new Error(issues.map((issue) => issue.message).join("; "));
    }
    if (normalized.description.length > MAX_DESCRIPTION_LENGTH) {
      throw new Error(`Description is longer than ${MAX_DESCRIPTION_LENGTH} characters`);
    }
    return normalized;
  }

  async create(input: { definition: FlowDefinition; origin: FlowOrigin }): Promise<Flow> {
    const definition = this.normalize(input.definition);
    const existing = (await this.store.flows.list()).find((f) => f.name === definition.name);
    if (existing) {
      // An agent saving again under its own flow's name replaces it, back to waiting.
      if (
        input.origin.kind === "agent" &&
        existing.origin.kind === "agent" &&
        existing.origin.agentId === input.origin.agentId
      ) {
        return this.replace(existing, definition, false);
      }
      throw new FlowStateError(`A flow named "${definition.name}" already exists`);
    }
    const at = now();
    const flow: Flow = {
      id: randomBytes(4).toString("hex"),
      ...definition,
      origin: input.origin,
      approved: input.origin.kind === "user",
      revision: 1,
      createdAt: at,
      updatedAt: at,
    };
    return this.store.flows.put(flow);
  }

  async update(input: { id: string; definition: FlowDefinition }): Promise<Flow> {
    const existing = await this.get(input.id);
    const definition = this.normalize(input.definition);
    const clash = (await this.store.flows.list()).find(
      (f) => f.name === definition.name && f.id !== existing.id,
    );
    if (clash) throw new FlowStateError(`A flow named "${definition.name}" already exists`);
    return this.replace(existing, definition, existing.approved);
  }

  private replace(existing: Flow, definition: FlowDefinition, approved: boolean): Promise<Flow> {
    const { argumentHint: _dropped, ...rest } = existing;
    return this.store.flows.put({
      ...rest,
      ...definition,
      approved,
      revision: existing.revision + 1,
      updatedAt: now(),
    });
  }

  async approve(id: string): Promise<Flow> {
    const flow = await this.get(id);
    if (flow.approved) return flow;
    return this.store.flows.put({ ...flow, approved: true, updatedAt: now() });
  }

  async delete(id: string): Promise<void> {
    await this.get(id);
    for (const run of await this.store.listRuns(id)) {
      this.stopRun(run.id);
    }
    await this.store.deleteFlow(id);
  }

  async getRun(runId: string): Promise<FlowRun> {
    const run = await this.store.runs.get(runId);
    if (!run) throw new FlowNotFoundError(`run ${runId}`);
    return run;
  }

  // Creates a run for the chat `agentId`. A flow the owner has not approved gets a run that waits
  // for the card's Run button; every other flow starts at once. Returns before any step finishes.
  async startRun(input: { name: string; input: string; agentId: string }): Promise<FlowRun> {
    const flow = await this.getByName(input.name);
    const chat =
      this.agentManager.getAgent(input.agentId) ?? (await this.agentStorage.get(input.agentId));
    if (!chat?.workspaceId) {
      throw new FlowStateError("Flows run from a chat that belongs to a workspace");
    }
    const order = topologicalOrder(flow.flow) ?? [];
    const run: FlowRun = {
      id: randomBytes(4).toString("hex"),
      flowId: flow.id,
      flowName: flow.name,
      revision: flow.revision,
      agentId: input.agentId,
      workspaceId: chat.workspaceId,
      cwd: chat.cwd,
      input: input.input,
      status: flow.approved ? "running" : "awaiting_approval",
      startedAt: now(),
      endedAt: null,
      steps: order.map(pendingStep),
      output: null,
      error: null,
    };
    if (flow.approved) this.assertCapacity();
    await this.store.runs.put(run);
    await this.store.pruneRuns(flow.id);
    if (flow.approved) this.launch(flow, run);
    return run;
  }

  // Starts the same run record again from its first step on the flow as it is now.
  async retryRun(runId: string): Promise<FlowRun> {
    const previous = await this.getRun(runId);
    if (previous.status === "running" || this.active.has(runId)) {
      throw new FlowStateError("The run is still running");
    }
    const flow = await this.get(previous.flowId);
    if (!flow.approved) {
      throw new FlowStateError(`Approve "${flow.name}" before running it`);
    }
    this.assertCapacity();
    const run: FlowRun = {
      ...previous,
      flowName: flow.name,
      revision: flow.revision,
      status: "running",
      startedAt: now(),
      endedAt: null,
      steps: (topologicalOrder(flow.flow) ?? []).map(pendingStep),
      output: null,
      error: null,
    };
    await this.store.runs.put(run);
    this.launch(flow, run);
    return run;
  }

  async cancelRun(runId: string): Promise<FlowRun> {
    const run = await this.getRun(runId);
    if (run.status === "awaiting_approval") {
      return this.store.runs.put({ ...run, status: "cancelled", endedAt: now() });
    }
    this.stopRun(runId);
    return run;
  }

  // The chat that started a run is gone: its runs stop with it.
  cancelForAgent(agentId: string): void {
    for (const [runId, active] of this.active) {
      if (active.agentId === agentId) this.stopRun(runId);
    }
  }

  private assertCapacity(): void {
    if (this.active.size >= MAX_ACTIVE_RUNS) {
      throw new FlowStateError(`${this.active.size} flow runs are already running on this host`);
    }
  }

  private stopRun(runId: string, reason: "cancelled" | "timed_out" = "cancelled"): void {
    const active = this.active.get(runId);
    if (!active || active.handle.stopReason) return;
    active.handle.stopReason = reason;
    for (const step of active.handle.steps) {
      step.stopReason ??= reason;
      const agentId = step.agentId;
      if (agentId) {
        void this.agentManager.cancelAgentRun(agentId).catch((error: unknown) => {
          this.logger.warn({ err: error, runId, agentId }, "Failed to cancel flow agent");
        });
      }
    }
  }

  private launch(flow: Flow, run: FlowRun): void {
    const handle: RunHandle = { stopReason: null, steps: new Set() };
    this.active.set(run.id, { handle, agentId: run.agentId });
    void this.execute(flow, run, handle)
      .catch((error: unknown) => {
        this.logger.error({ err: error, runId: run.id }, "Flow run crashed");
      })
      .finally(() => this.active.delete(run.id));
  }

  private async execute(flow: Flow, run: FlowRun, handle: RunHandle): Promise<void> {
    const timer = setTimeout(() => this.stopRun(run.id, "timed_out"), MAX_RUN_RUNTIME_MS);
    timer.unref?.();
    const updateStep = async (nodeId: string, patch: StepPatch) => {
      await this.store.runs.update(run.id, (current) => ({
        ...current,
        steps: current.steps.map((step) => (step.nodeId === nodeId ? { ...step, ...patch } : step)),
      }));
    };
    let result: FlowRunResult;
    try {
      result = await runFlow(this.engine, {
        subject: { id: flow.id, name: flow.name, cwd: run.cwd, flow: flow.flow },
        run,
        handle,
        pullRequest: null,
        input: run.input,
        runTitle: flow.name,
        agentLabels: {
          [PARENT_AGENT_ID_LABEL]: run.agentId,
          "pimi.flow-id": flow.id,
          "pimi.flow-run": run.id,
        },
        openWorkspace: async () => ({
          workspaceId: run.workspaceId,
          cwd: run.cwd,
          createdWorktree: false,
        }),
        updateStep,
      });
    } catch (error) {
      result = {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        reportAgentId: null,
        notMet: false,
        output: null,
      };
    } finally {
      clearTimeout(timer);
    }
    const finished = await this.finishRun(run.id, result);
    if (finished) await this.deliver(finished);
  }

  private async finishRun(runId: string, result: FlowRunResult): Promise<FlowRun | null> {
    return this.store.runs.update(runId, (current) => {
      const unmet = result.notMet
        ? current.steps.find((step) => step.status === "failed" && step.verdicts?.length)
        : undefined;
      if (result.notMet) {
        const feedback = unmet?.verdicts?.at(-1)?.feedback ?? result.error;
        return { ...current, status: "not_met", endedAt: now(), output: feedback, error: null };
      }
      const output = result.status === "succeeded" ? result.output : null;
      return { ...current, status: result.status, endedAt: now(), output, error: result.error };
    });
  }

  // Tells the chat how the run ended. A cancelled run says nothing: whoever cancelled it knows.
  private async deliver(run: FlowRun): Promise<void> {
    if (run.status === "cancelled") return;
    const text = describeFinishedRun(run);
    try {
      const agent = await ensureAgentLoaded(run.agentId, {
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        logger: this.logger,
      });
      await startAgentRun(
        this.agentManager,
        agent.id,
        formatSystemNotificationPrompt(text),
        this.logger,
        { activeTurnBehavior: "steer" },
      );
    } catch (error) {
      this.logger.warn(
        { err: error, runId: run.id, agentId: run.agentId },
        "Flow result not delivered",
      );
    }
  }
}
