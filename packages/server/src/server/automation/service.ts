import { randomBytes, randomUUID } from "node:crypto";
import type { AgentProfile } from "@pimi/protocol/agent-profile";
import { requireAgentProfile } from "../agent/profiles/resolve.js";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Logger } from "pino";
import {
  DEFAULT_AUTOMATION_LIMITS,
  type Automation,
  type AutomationActor,
  type AutomationAuditEntry,
  type AutomationDefinition,
  type AutomationOrigin,
  type AutomationRun,
  type AutomationRunCause,
  type AutomationRunStatus,
} from "@pimi/protocol/automation/types";
import {
  readSingleAgentFlow,
  validateAutomationDefinition,
} from "@pimi/protocol/automation/validate";
import { AutomationAuditLog } from "./audit.js";
import { computeNextRunAt, validateCadence, withHostTimeZone } from "./cron.js";
import {
  type AutomationEngineDeps,
  type RunHandle,
  RunStoppedError,
  runAgentStep,
} from "./engine.js";
import { AutomationStore } from "./store.js";

const TICK_INTERVAL_MS = 1000;
const DAEMON_AUTOMATION_AGENT_CAP = 4;
const FAILURES_BEFORE_PAUSE = 3;
const AUDIT_ENTRIES_RETURNED = 50;
const HOUR_MS = 60 * 60_000;
// Cron cannot fire more often than once a minute; an interval gets the same floor, so a bad
// definition cannot turn the tick loop into a stream of skipped runs.
const MIN_EVERY_MS = 60_000;
const MAX_NAME_LENGTH = 200;
const MAX_PROMPT_LENGTH = 100_000;

export class AutomationNotFoundError extends Error {
  constructor(id: string) {
    super(`Automation not found: ${id}`);
    this.name = "AutomationNotFoundError";
  }
}

export class AutomationRunNotFoundError extends Error {
  constructor(id: string) {
    super(`Automation run not found: ${id}`);
    this.name = "AutomationRunNotFoundError";
  }
}

export class AutomationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationStateError";
  }
}

export interface AutomationServiceOptions extends Omit<AutomationEngineDeps, "logger"> {
  paseoHome: string;
  logger: Logger;
  /** The host's agent profiles; an agent step may name one. */
  getAgentProfiles: () => readonly AgentProfile[];
}

interface ActiveRun {
  automationId: string;
  handle: RunHandle;
}

type NormalizedDefinition = Pick<
  Automation,
  "name" | "description" | "project" | "trigger" | "flow" | "limits"
>;

function hasEnded(automation: Automation, now: Date): boolean {
  const { expiresAt, maxRuns } = automation.limits;
  if (expiresAt && new Date(expiresAt).getTime() <= now.getTime()) {
    return true;
  }
  return maxRuns !== null && automation.runCount >= maxRuns;
}

function advancePast(automation: Automation, from: Date, now: Date): Date {
  if (automation.trigger.kind !== "schedule") {
    return from;
  }
  let next = from;
  while (next.getTime() <= now.getTime()) {
    next = computeNextRunAt(automation.trigger.cadence, next);
  }
  return next;
}

function scheduledNextRunAt(
  automation: Pick<Automation, "status" | "trigger">,
  now: Date,
): string | null {
  if (automation.status !== "active" || automation.trigger.kind !== "schedule") {
    return null;
  }
  return computeNextRunAt(automation.trigger.cadence, now).toISOString();
}

// An agent step's profile is stored by id; callers may name it.
function normalizeFlowProfiles(
  flow: AutomationDefinition["flow"],
  profiles: readonly AgentProfile[],
): AutomationDefinition["flow"] {
  return {
    ...flow,
    nodes: flow.nodes.map((node) => {
      if (node.kind !== "agent") return node;
      const requested = node.profileId?.trim();
      if (!requested) {
        const { profileId: _dropped, ...rest } = node;
        return rest;
      }
      return { ...node, profileId: requireAgentProfile(profiles, requested).id };
    }),
  };
}

function normalizeDefinition(
  definition: AutomationDefinition,
  profiles: readonly AgentProfile[],
): NormalizedDefinition {
  const issues = validateAutomationDefinition(definition);
  if (issues.length > 0) {
    throw new Error(issues.map((issue) => issue.message).join("; "));
  }
  const trigger =
    definition.trigger.kind === "schedule"
      ? { ...definition.trigger, cadence: withHostTimeZone(definition.trigger.cadence) }
      : definition.trigger;
  if (trigger.kind === "schedule") {
    const cadence = trigger.cadence;
    if (cadence.type === "every" && cadence.everyMs < MIN_EVERY_MS) {
      throw new Error(`An automation cannot run more often than every ${MIN_EVERY_MS / 1000}s`);
    }
    validateCadence(cadence);
  }
  if (definition.name.trim().length > MAX_NAME_LENGTH) {
    throw new Error(`Name is longer than ${MAX_NAME_LENGTH} characters`);
  }
  for (const node of definition.flow.nodes) {
    if (node.kind === "agent" && node.prompt.length > MAX_PROMPT_LENGTH) {
      throw new Error(`Prompt is longer than ${MAX_PROMPT_LENGTH} characters`);
    }
  }
  const limits = { ...DEFAULT_AUTOMATION_LIMITS, ...definition.limits };
  if (limits.expiresAt !== null && Number.isNaN(new Date(limits.expiresAt).getTime())) {
    throw new Error(`Invalid expiry: ${limits.expiresAt}`);
  }
  const description = definition.description?.trim();
  return {
    name: definition.name.trim(),
    description: description ? description : null,
    project: { cwd: resolve(definition.project.cwd.trim()) },
    trigger,
    flow: normalizeFlowProfiles(definition.flow, profiles),
    limits,
  };
}

function requireFound<T>(value: T | null, id: string): T {
  if (value === null) {
    throw new AutomationNotFoundError(id);
  }
  return value;
}

// Owns automation definitions, admission, run records, limits, and the clock trigger.
export class AutomationService {
  private readonly logger: Logger;
  private readonly paseoHome: string;
  private readonly store: AutomationStore;
  private readonly audit: AutomationAuditLog;
  private readonly engine: AutomationEngineDeps;
  private readonly getAgentProfiles: () => readonly AgentProfile[];
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly originLocks = new Map<string, Promise<unknown>>();
  private admission: Promise<unknown> = Promise.resolve();
  private archiveQueue: Promise<void> = Promise.resolve();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(options: AutomationServiceOptions) {
    this.logger = options.logger.child({ module: "automation-service" });
    this.paseoHome = options.paseoHome;
    this.getAgentProfiles = options.getAgentProfiles;
    const dir = join(options.paseoHome, "automations");
    this.store = new AutomationStore({ dir, logger: this.logger });
    this.audit = new AutomationAuditLog({ dir, logger: this.logger });
    this.engine = {
      logger: this.logger,
      agentManager: options.agentManager,
      createAgent: options.createAgent,
      createDirectoryWorkspace: options.createDirectoryWorkspace,
      createWorktreeWorkspace: options.createWorktreeWorkspace,
      archiveWorkspace: options.archiveWorkspace,
    };
  }

  async start(): Promise<void> {
    // Schedules from earlier builds are not migrated.
    await rm(join(this.paseoHome, "schedules"), { recursive: true, force: true });
    await this.recover();
    if (this.tickTimer) {
      return;
    }
    const timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.logger.error({ err: error }, "Failed to process automation tick");
      });
    }, TICK_INTERVAL_MS);
    timer.unref?.();
    this.tickTimer = timer;
  }

  async stop(): Promise<void> {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  async list(): Promise<Automation[]> {
    const automations = await this.store.automations.list();
    return automations.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async get(id: string): Promise<Automation> {
    return requireFound(await this.store.automations.get(id), id);
  }

  async getWithAudit(
    id: string,
  ): Promise<{ automation: Automation; audit: AutomationAuditEntry[] }> {
    const automation = await this.get(id);
    const audit = await this.audit.readForAutomation(id, AUDIT_ENTRIES_RETURNED);
    return { automation, audit };
  }

  // A user's automation is active at once. An agent's waits in `pending` for the owner;
  // creating one with the name of one the same agent already made replaces it and puts it
  // back in `pending`.
  async create(input: {
    definition: AutomationDefinition;
    origin: AutomationOrigin;
  }): Promise<Automation> {
    const fields = normalizeDefinition(input.definition, this.getAgentProfiles());
    const origin = input.origin;
    const actor: AutomationActor = origin;
    const now = new Date();
    if (origin.kind === "agent") {
      return this.withOriginLock(`${origin.agentId}\u0000${fields.name}`, async () => {
        const existing = (await this.store.automations.list()).find(
          (automation) =>
            automation.origin.kind === "agent" &&
            automation.origin.agentId === origin.agentId &&
            automation.name === fields.name &&
            automation.status !== "ended",
        );
        if (existing) {
          const replaced = await this.store.automations.update(existing.id, (current) => ({
            ...current,
            ...fields,
            status: "pending",
            pausedReason: null,
            nextRunAt: null,
            revision: current.revision + 1,
            updatedAt: now.toISOString(),
          }));
          if (replaced) {
            await this.audit.append({
              automationId: replaced.id,
              action: "updated",
              actor,
              runId: null,
              detail: "replaced; waiting for approval",
            });
            return replaced;
          }
        }
        return this.insert(fields, origin, "pending", now);
      });
    }
    return this.insert(fields, origin, "active", now);
  }

  private async insert(
    fields: NormalizedDefinition,
    origin: AutomationOrigin,
    status: "active" | "pending",
    now: Date,
  ): Promise<Automation> {
    const automation: Automation = {
      ...fields,
      id: randomBytes(4).toString("hex"),
      status,
      pausedReason: null,
      origin,
      revision: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      nextRunAt: null,
      lastRun: null,
      runCount: 0,
      consecutiveFailures: 0,
    };
    automation.nextRunAt = scheduledNextRunAt(automation, now);
    const created = await this.store.automations.put(automation);
    await this.audit.append({
      automationId: created.id,
      action: "created",
      actor: origin,
      runId: null,
      detail: status === "pending" ? "waiting for approval" : null,
    });
    return created;
  }

  async update(input: {
    id: string;
    definition: AutomationDefinition;
    actor: AutomationActor;
  }): Promise<Automation> {
    const fields = normalizeDefinition(input.definition, this.getAgentProfiles());
    const now = new Date();
    const updated = await this.store.automations.update(input.id, (current) => {
      if (current.status === "ended") {
        throw new AutomationStateError(`Automation ${input.id} has ended`);
      }
      const next: Automation = {
        ...current,
        ...fields,
        revision: current.revision + 1,
        updatedAt: now.toISOString(),
      };
      next.nextRunAt = scheduledNextRunAt(next, now);
      return next;
    });
    const automation = requireFound(updated, input.id);
    await this.audit.append({
      automationId: automation.id,
      action: "updated",
      actor: input.actor,
      runId: null,
      detail: `revision ${automation.revision}`,
    });
    return automation;
  }

  // Runs still going are cancelled here and archive their own workspaces when they stop.
  async delete(id: string, actor: AutomationActor): Promise<void> {
    await this.get(id);
    for (const [runId, active] of this.activeRuns) {
      if (active.automationId === id) {
        this.stopRun(runId, "cancelled");
      }
    }
    const finished = (await this.store.listRuns(id)).filter((run) => run.status !== "running");
    await this.store.deleteAutomation(id);
    this.archiveRunWorkspaces(finished);
    await this.audit.append({
      automationId: id,
      action: "deleted",
      actor,
      runId: null,
      detail: null,
    });
  }

  async approve(id: string, actor: AutomationActor): Promise<Automation> {
    return this.transition(id, actor, "approved", (current, now) => {
      if (current.status !== "pending") {
        throw new AutomationStateError(`Automation ${id} is not waiting for approval`);
      }
      return {
        ...current,
        status: "active",
        nextRunAt: scheduledNextRunAt({ ...current, status: "active" }, now),
      };
    });
  }

  async enable(id: string, actor: AutomationActor): Promise<Automation> {
    return this.transition(id, actor, "enabled", (current, now) => {
      if (current.status === "pending") {
        throw new AutomationStateError(`Automation ${id} is waiting for approval`);
      }
      if (current.status === "ended") {
        throw new AutomationStateError(`Automation ${id} has ended`);
      }
      if (current.status === "active") {
        return current;
      }
      return {
        ...current,
        status: "active",
        pausedReason: null,
        consecutiveFailures: 0,
        nextRunAt: scheduledNextRunAt({ ...current, status: "active" }, now),
      };
    });
  }

  async pause(id: string, actor: AutomationActor): Promise<Automation> {
    return this.transition(id, actor, "paused", (current) => {
      if (current.status === "pending") {
        throw new AutomationStateError(`Automation ${id} is waiting for approval`);
      }
      if (current.status === "ended") {
        throw new AutomationStateError(`Automation ${id} has ended`);
      }
      if (current.status === "paused") {
        return current;
      }
      return { ...current, status: "paused", pausedReason: "user", nextRunAt: null };
    });
  }

  private async transition(
    id: string,
    actor: AutomationActor,
    action: AutomationAuditEntry["action"],
    apply: (current: Automation, now: Date) => Automation,
  ): Promise<Automation> {
    const now = new Date();
    let changed = false;
    const updated = await this.store.automations.update(id, (current) => {
      const next = apply(current, now);
      if (next === current) {
        return current;
      }
      changed = true;
      return { ...next, updatedAt: now.toISOString() };
    });
    const automation = requireFound(updated, id);
    if (changed) {
      await this.audit.append({ automationId: id, action, actor, runId: null, detail: null });
    }
    return automation;
  }

  async listRuns(input: { automationId?: string; limit?: number }): Promise<AutomationRun[]> {
    const ids = input.automationId
      ? [(await this.get(input.automationId)).id]
      : (await this.store.automations.list()).map((automation) => automation.id);
    const runs = (await Promise.all(ids.map((id) => this.store.listRuns(id)))).flat();
    runs.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    return input.limit ? runs.slice(0, input.limit) : runs;
  }

  async getRun(automationId: string, runId: string): Promise<AutomationRun> {
    await this.get(automationId);
    const run = await this.store.runs(automationId).get(runId);
    if (!run) {
      throw new AutomationRunNotFoundError(runId);
    }
    return run;
  }

  async markRunRead(automationId: string, runId: string): Promise<AutomationRun> {
    await this.get(automationId);
    const run = await this.store
      .runs(automationId)
      .update(runId, (current) => (current.unread ? { ...current, unread: false } : current));
    if (!run) {
      throw new AutomationRunNotFoundError(runId);
    }
    return run;
  }

  // Starts a run now and returns it while it is still running.
  async startManualRun(id: string, actor: AutomationActor): Promise<AutomationRun> {
    const automation = await this.get(id);
    if (automation.status === "pending") {
      throw new AutomationStateError(`Automation ${id} is waiting for approval`);
    }
    if (automation.status === "ended") {
      throw new AutomationStateError(`Automation ${id} has ended`);
    }
    if (actor.kind === "agent" && automation.status !== "active") {
      throw new AutomationStateError(`Automation ${id} is paused`);
    }
    return this.admit(async () => {
      const refusal = await this.admissionRefusal(automation, new Date());
      if (refusal) {
        throw new AutomationStateError(refusal);
      }
      return this.startRun(automation, { kind: "manual", actor }, actor);
    });
  }

  // Checking the limits and registering the run happen one admission at a time. Otherwise two
  // starts that arrive together both pass the check and exceed the caps.
  private admit<T>(work: () => Promise<T>): Promise<T> {
    const next = this.admission.catch(() => undefined).then(work);
    this.admission = next;
    return next;
  }

  async cancelRun(automationId: string, runId: string): Promise<AutomationRun> {
    const run = await this.getRun(automationId, runId);
    if (run.status !== "running") {
      return run;
    }
    if (this.activeRuns.has(runId)) {
      this.stopRun(runId, "cancelled");
      return run;
    }
    // A running record with no live run in this process: nothing is left to stop.
    return this.finishRun({ automationId, runId, status: "cancelled", output: null, error: null });
  }

  private stopRun(runId: string, reason: RunHandle["stopReason"] & string): void {
    const active = this.activeRuns.get(runId);
    if (!active || active.handle.stopReason) {
      return;
    }
    active.handle.stopReason = reason;
    const agentId = active.handle.agentId;
    if (agentId) {
      void this.engine.agentManager.cancelAgentRun(agentId).catch((error: unknown) => {
        this.logger.warn({ err: error, runId, agentId }, "Failed to cancel automation agent");
      });
    }
  }

  private async admissionRefusal(automation: Automation, now: Date): Promise<string | null> {
    const running = [...this.activeRuns.values()].filter(
      (active) => active.automationId === automation.id,
    ).length;
    if (running >= automation.limits.maxConcurrentRuns) {
      return `Automation ${automation.id} already has ${running} running run(s)`;
    }
    if (this.activeRuns.size >= DAEMON_AUTOMATION_AGENT_CAP) {
      return `${this.activeRuns.size} automation runs are already running on this host`;
    }
    const recent = (await this.store.listRuns(automation.id)).filter(
      (run) => new Date(run.startedAt).getTime() > now.getTime() - HOUR_MS,
    ).length;
    if (recent >= automation.limits.maxRunsPerHour) {
      return `Automation ${automation.id} reached its limit of ${automation.limits.maxRunsPerHour} runs per hour`;
    }
    return null;
  }

  private async startRun(
    automation: Automation,
    cause: AutomationRunCause,
    actor: AutomationActor,
  ): Promise<AutomationRun> {
    const flow = readSingleAgentFlow(automation.flow);
    if (!flow) {
      throw new AutomationStateError(`Automation ${automation.id} has a flow this host cannot run`);
    }
    const now = new Date().toISOString();
    const runId = randomUUID();
    const run: AutomationRun = {
      id: runId,
      automationId: automation.id,
      revision: automation.revision,
      cause,
      dedupeKey:
        cause.kind === "trigger" ? `schedule:${cause.event.scheduledFor}` : `manual:${runId}`,
      status: "running",
      unread: true,
      startedAt: now,
      endedAt: null,
      reportAgentId: null,
      reportWorkspaceId: null,
      steps: [
        {
          nodeId: flow.agent.id,
          status: "running",
          agentId: null,
          workspaceId: null,
          modeId: null,
          startedAt: now,
          endedAt: null,
          output: null,
          error: null,
        },
      ],
      error: null,
    };
    const handle: RunHandle = { agentId: null, stopReason: null };
    this.activeRuns.set(runId, { automationId: automation.id, handle });
    try {
      await this.store.runs(automation.id).put(run);
      await this.store.automations.update(automation.id, (current) => ({
        ...current,
        runCount: current.runCount + 1,
        lastRun: { id: runId, status: "running", startedAt: now, endedAt: null },
        updatedAt: now,
      }));
    } catch (error) {
      this.activeRuns.delete(runId);
      throw error;
    }
    await this.audit.append({
      automationId: automation.id,
      action: "run_started",
      actor,
      runId,
      detail: cause.kind === "manual" ? "manual" : "schedule",
    });
    void this.execute(automation, run, handle).finally(() => {
      this.activeRuns.delete(runId);
    });
    return run;
  }

  private async execute(automation: Automation, run: AutomationRun, handle: RunHandle) {
    const flow = readSingleAgentFlow(automation.flow)!;
    const timer = setTimeout(
      () => this.stopRun(run.id, "timed_out"),
      automation.limits.maxRuntimeMs,
    );
    timer.unref?.();
    const runs = this.store.runs(automation.id);
    let status: AutomationRunStatus = "succeeded";
    let output: string | null = null;
    let error: string | null = null;
    let workspaceIdSeen: string | null = null;
    try {
      const result = await runAgentStep(this.engine, {
        automation,
        run,
        node: flow.agent,
        handle,
        callbacks: {
          onWorkspace: async (workspaceId) => {
            workspaceIdSeen = workspaceId;
            await runs.update(run.id, (current) => ({
              ...current,
              reportWorkspaceId: workspaceId,
              steps: current.steps.map((step) => ({ ...step, workspaceId })),
            }));
          },
          onAgent: async (agentId, modeId) => {
            await runs.update(run.id, (current) => ({
              ...current,
              reportAgentId: agentId,
              steps: current.steps.map((step) => ({ ...step, agentId, modeId })),
            }));
          },
        },
      });
      output = result.output;
    } catch (cause) {
      if (cause instanceof RunStoppedError && cause.reason === "cancelled") {
        status = "cancelled";
      } else {
        status = "failed";
        error = cause instanceof Error ? cause.message : String(cause);
      }
    } finally {
      clearTimeout(timer);
    }
    try {
      // Deleting an automation cancels its runs and removes their records; nothing is left to
      // finish, and touching the run store would recreate its directory. The workspace the run
      // opened goes with it.
      if ((await this.store.automations.get(automation.id)) === null) {
        this.archiveRunWorkspaces([{ ...run, reportWorkspaceId: workspaceIdSeen, steps: [] }]);
        return;
      }
      await this.finishRun({ automationId: automation.id, runId: run.id, status, output, error });
    } catch (finishError) {
      this.logger.error(
        { err: finishError, automationId: automation.id, runId: run.id },
        "Failed to record automation run result",
      );
    }
  }

  private async finishRun(input: {
    automationId: string;
    runId: string;
    status: Exclude<AutomationRunStatus, "running">;
    output: string | null;
    error: string | null;
  }): Promise<AutomationRun> {
    const endedAt = new Date().toISOString();
    const run = await this.store.runs(input.automationId).update(input.runId, (current) => ({
      ...current,
      status: input.status,
      endedAt,
      error: input.error,
      steps: current.steps.map((step) => ({
        ...step,
        status: input.status,
        endedAt,
        output: input.output,
        error: input.error,
      })),
    }));
    if (!run) {
      throw new AutomationRunNotFoundError(input.runId);
    }
    let autoPaused = false;
    let ended = false;
    await this.store.automations.update(input.automationId, (current) => {
      const consecutiveFailures = nextConsecutiveFailures(
        current.consecutiveFailures,
        input.status,
      );
      let next: Automation = {
        ...current,
        consecutiveFailures,
        lastRun:
          current.lastRun?.id === input.runId || current.lastRun === null
            ? { id: run.id, status: run.status, startedAt: run.startedAt, endedAt }
            : current.lastRun,
        updatedAt: endedAt,
      };
      if (next.status === "active" && consecutiveFailures >= FAILURES_BEFORE_PAUSE) {
        next = { ...next, status: "paused", pausedReason: "failures", nextRunAt: null };
        autoPaused = true;
      } else if (next.status !== "ended" && hasEnded(next, new Date(endedAt))) {
        next = { ...next, status: "ended", pausedReason: null, nextRunAt: null };
        ended = true;
      }
      return next;
    });
    const daemon: AutomationActor = { kind: "daemon" };
    await this.audit.append({
      automationId: input.automationId,
      action: "run_finished",
      actor: daemon,
      runId: input.runId,
      detail: input.status,
    });
    if (autoPaused) {
      await this.audit.append({
        automationId: input.automationId,
      if (run.reportWorkspaceId) {
        workspaceIds.add(run.reportWorkspaceId);
      }
        action: "auto_paused",
        actor: daemon,
        runId: input.runId,
        detail: `${FAILURES_BEFORE_PAUSE} failed runs in a row`,
      });
    }
    if (ended) {
      await this.audit.append({
        automationId: input.automationId,
        action: "ended",
        actor: daemon,
        runId: input.runId,
        detail: null,
      });
    }
    await this.pruneRuns(input.automationId, new Date());
    return run;
  }

  private async pruneRuns(automationId: string, now: Date): Promise<void> {
    this.archiveRunWorkspaces(await this.store.pruneRuns(automationId, now));
  }

  // Archives the workspaces (and any worktree they own) of runs whose records are gone. Runs
  // one at a time in the background: archiving touches git and should not hold up the caller.
  private archiveRunWorkspaces(runs: readonly AutomationRun[]): void {
    const workspaceIds = new Set<string>();
    for (const run of runs) {
      for (const step of run.steps) {
        if (step.workspaceId) {
          workspaceIds.add(step.workspaceId);
        }
      }
    }
    if (workspaceIds.size === 0) {
      return;
    }
    this.archiveQueue = this.archiveQueue.then(() => this.archiveEach(workspaceIds));
  }

  private async archiveEach(workspaceIds: Iterable<string>): Promise<void> {
    for (const workspaceId of workspaceIds) {
      try {
        await this.engine.archiveWorkspace(workspaceId);
      } catch (error) {
        this.logger.warn({ err: error, workspaceId }, "Failed to archive automation run workspace");
      }
    }
  }

  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      const now = new Date();
      for (const automation of await this.store.automations.list()) {
        if (automation.status !== "active") {
          continue;
        }
        if (hasEnded(automation, now)) {
          await this.endAutomation(automation.id, now);
          continue;
        }
        if (
          automation.trigger.kind !== "schedule" ||
          !automation.nextRunAt ||
          new Date(automation.nextRunAt).getTime() > now.getTime()
        ) {
          continue;
        }
        await this.fireSchedule(automation.id, now);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async fireSchedule(id: string, now: Date): Promise<void> {
    let scheduledFor: string | null = null;
    const claimed = await this.store.automations.update(id, (current) => {
      if (
        current.status !== "active" ||
        current.trigger.kind !== "schedule" ||
        !current.nextRunAt ||
        new Date(current.nextRunAt).getTime() > now.getTime()
      ) {
        return current;
      }
      scheduledFor = current.nextRunAt;
      const following = computeNextRunAt(current.trigger.cadence, new Date(current.nextRunAt));
      return {
        ...current,
        nextRunAt: advancePast(current, following, now).toISOString(),
        updatedAt: now.toISOString(),
      };
    });
    if (!claimed || scheduledFor === null) {
      return;
    }
    const daemon: AutomationActor = { kind: "daemon" };
    const slot: string = scheduledFor;
    await this.admit(async () => {
      const refusal = await this.admissionRefusal(claimed, now);
      if (refusal) {
        await this.audit.append({
          automationId: id,
          action: "run_skipped",
          actor: daemon,
          runId: null,
          detail: refusal,
        });
        return;
      }
      try {
        await this.startRun(
          claimed,
          { kind: "trigger", event: { kind: "schedule", scheduledFor: slot } },
          daemon,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error({ err: error, automationId: id }, "Failed to start scheduled run");
        await this.audit.append({
          automationId: id,
          action: "run_skipped",
          actor: daemon,
          runId: null,
          detail: `could not start: ${message}`.slice(0, 300),
        });
      }
    });
  }

  private async endAutomation(id: string, now: Date): Promise<void> {
    let ended = false;
    await this.store.automations.update(id, (current) => {
      if (current.status === "ended" || !hasEnded(current, now)) {
        return current;
      }
      ended = true;
      return {
        ...current,
        status: "ended",
        pausedReason: null,
        nextRunAt: null,
        updatedAt: now.toISOString(),
      };
    });
    if (ended) {
      await this.audit.append({
        automationId: id,
        action: "ended",
        actor: { kind: "daemon" },
        runId: null,
        detail: null,
      });
    }
  }

  // Runs left `running` by a previous daemon process failed; missed schedule slots are skipped.
  private async recover(): Promise<void> {
    const now = new Date();
    for (const automation of await this.store.automations.list()) {
      for (const run of await this.store.listRuns(automation.id)) {
        if (run.status !== "running") {
          continue;
        }
        const endedAt = now.toISOString();
        const error = "The daemon restarted before the run finished";
        const failed = await this.store.runs(automation.id).update(run.id, (current) => ({
          ...current,
          status: "failed",
          endedAt,
          error,
          steps: current.steps.map((step) =>
            step.status === "running" ? { ...step, status: "failed", endedAt, error } : step,
          ),
        }));
        if (failed && automation.lastRun?.id === run.id) {
          await this.store.automations.update(automation.id, (current) => ({
            ...current,
            lastRun: { id: run.id, status: "failed", startedAt: run.startedAt, endedAt },
          }));
        }
      }
      if (
        automation.status === "active" &&
        automation.nextRunAt &&
        new Date(automation.nextRunAt).getTime() <= now.getTime()
      ) {
        await this.store.automations.update(automation.id, (current) =>
          current.nextRunAt
            ? {
                ...current,
                nextRunAt: advancePast(current, new Date(current.nextRunAt), now).toISOString(),
              }
            : current,
        );
      }
      await this.pruneRuns(automation.id, now);
    }
  }

  private async withOriginLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.originLocks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.originLocks.set(key, next);
    try {
      return await next;
    } finally {
      if (this.originLocks.get(key) === next) {
        this.originLocks.delete(key);
      }
    }
  }
}

// A cancelled run neither counts as a failure nor clears the streak.
function nextConsecutiveFailures(current: number, status: AutomationRunStatus): number {
  if (status === "failed") {
    return current + 1;
  }
  return status === "succeeded" ? 0 : current;
}
