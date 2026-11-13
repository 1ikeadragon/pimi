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
  type AutomationDraft,
  type AutomationOrigin,
  type AutomationPullRequestEvent,
  type AutomationRun,
  type AutomationRunCause,
  type AutomationRunStatus,
  type AutomationRunStep,
} from "@pimi/protocol/automation/types";
import {
  topologicalOrder,
  upstreamNodeIds,
  validateAutomationDefinition,
} from "@pimi/protocol/automation/validate";
import type { PimiDatabase } from "../db/pimi-db.js";
import { AutomationAuditLog } from "./audit.js";
import { computeNextRunAt, validateCadence, withHostTimeZone } from "./cron.js";
import { type AutomationEngineDeps, type RunHandle, type RunWorkspace } from "./engine.js";
import { runFlow, type StepPatch } from "./flow-runner.js";
import {
  type GhRunner,
  PULL_REQUEST_POLL_INTERVAL_MS,
  pollPullRequests,
} from "./pull-request-trigger.js";
import { AutomationStore } from "./store.js";

const TICK_INTERVAL_MS = 1000;
const DAEMON_AUTOMATION_AGENT_CAP = 4;
const FAILURES_BEFORE_PAUSE = 3;
const AUDIT_ENTRIES_RETURNED = 50;
// A ready draft stays listed this long so every open client can announce it.
const READY_DRAFT_RETENTION_MS = 60 * 60_000;
// A failed draft waits for a retry or a dismissal this long before it is dropped.
const FAILED_DRAFT_RETENTION_MS = 7 * 24 * 60 * 60_000;
// A draft that is still compiling is never expired.
const DRAFT_RETENTION_MS: Record<AutomationDraft["state"], number | null> = {
  drafting: null,
  ready: READY_DRAFT_RETENTION_MS,
  failed: FAILED_DRAFT_RETENTION_MS,
};
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
  pimiHome: string;
  database: PimiDatabase;
  logger: Logger;
  /** The host's agent profiles; an agent step may name one. */
  getAgentProfiles: () => readonly AgentProfile[];
  /** Runs the host's `gh` CLI for pull-request triggers. */
  gh: GhRunner;
  /** Compiles prose into a draft definition with an LLM. */
  compile: (input: { description: string; cwd: string }) => Promise<AutomationDefinition>;
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

function normalizeTrigger(trigger: AutomationDefinition["trigger"]): Automation["trigger"] {
  if (trigger.kind === "schedule") {
    const cadence = withHostTimeZone(trigger.cadence);
    if (cadence.type === "every" && cadence.everyMs < MIN_EVERY_MS) {
      throw new Error(`An automation cannot run more often than every ${MIN_EVERY_MS / 1000}s`);
    }
    validateCadence(cadence);
    return { ...trigger, cadence };
  }
  if (trigger.kind === "pull_request") {
    return { ...trigger, repo: trigger.repo.trim(), events: [...new Set(trigger.events)] };
  }
  return trigger;
}

function normalizeDefinition(
  definition: AutomationDefinition,
  profiles: readonly AgentProfile[],
): NormalizedDefinition {
  const issues = validateAutomationDefinition(definition);
  if (issues.length > 0) {
    throw new Error(issues.map((issue) => issue.message).join("; "));
  }
  if (definition.name.trim().length > MAX_NAME_LENGTH) {
    throw new Error(`Name is longer than ${MAX_NAME_LENGTH} characters`);
  }
  for (const node of definition.flow.nodes) {
    const text = node.kind === "agent" ? node.prompt : node.input;
    if (text.length > MAX_PROMPT_LENGTH) {
      throw new Error(`Step ${node.id} is longer than ${MAX_PROMPT_LENGTH} characters`);
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
    trigger: normalizeTrigger(definition.trigger),
    flow: normalizeFlowProfiles(definition.flow, profiles),
    limits,
  };
}

function sameTrigger(left: Automation["trigger"], right: Automation["trigger"]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireFound<T>(value: T | null, id: string): T {
  if (value === null) {
    throw new AutomationNotFoundError(id);
  }
  return value;
}

function pendingStep(nodeId: string): AutomationRunStep {
  return {
    nodeId,
    status: "pending",
    agentId: null,
    workspaceId: null,
    createdWorktree: false,
    modeId: null,
    startedAt: null,
    endedAt: null,
    output: null,
    error: null,
  };
}

// The steps a retry of `source` starts with. A step that succeeded is reused when every step it
// depends on is reused too; everything else runs again. Steps the flow no longer has are dropped.
function retrySteps(automation: Automation, source: AutomationRun): AutomationRunStep[] {
  const order = topologicalOrder(automation.flow) ?? [];
  const reused = new Set<string>();
  const steps: AutomationRunStep[] = [];
  for (const nodeId of order) {
    const previous = source.steps.find((step) => step.nodeId === nodeId);
    const upstream = upstreamNodeIds(automation.flow, nodeId);
    const canReuse =
      previous?.status === "succeeded" && [...upstream].every((id) => reused.has(id));
    if (canReuse && previous) {
      reused.add(nodeId);
      steps.push({ ...previous, reusedFrom: previous.reusedFrom ?? source.id });
    } else {
      steps.push(pendingStep(nodeId));
    }
  }
  return steps;
}

function describeCause(cause: AutomationRunCause): string {
  if (cause.kind === "manual") {
    return "manual";
  }
  if (cause.kind === "retry") {
    return `retry of ${cause.runId}`;
  }
  if (cause.event.kind === "pull_request") {
    return `pull request #${cause.event.number} ${cause.event.action}`;
  }
  return "schedule";
}

function dedupeKeyFor(cause: AutomationRunCause, runId: string): string {
  if (cause.kind === "manual") {
    return `manual:${runId}`;
  }
  if (cause.kind === "retry") {
    return `retry:${cause.runId}:${runId}`;
  }
  if (cause.event.kind === "pull_request") {
    return `pr:${cause.event.repo}#${cause.event.number}@${cause.event.headSha}`;
  }
  return `schedule:${cause.event.scheduledFor}`;
}

// Owns automation definitions, admission, run records, limits, and the clock and pull-request
// triggers.
export class AutomationService {
  private readonly logger: Logger;
  private readonly pimiHome: string;
  private readonly store: AutomationStore;
  private readonly audit: AutomationAuditLog;
  private readonly engine: AutomationEngineDeps;
  private readonly getAgentProfiles: () => readonly AgentProfile[];
  private readonly gh: GhRunner;
  private readonly compileDefinition: AutomationServiceOptions["compile"];
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly originLocks = new Map<string, Promise<unknown>>();
  private readonly polling = new Map<string, Promise<AutomationRun[]>>();
  private admission: Promise<unknown> = Promise.resolve();
  private archiveQueue: Promise<void> = Promise.resolve();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private readonly draftListeners = new Set<() => void>();

  constructor(options: AutomationServiceOptions) {
    this.logger = options.logger.child({ module: "automation-service" });
    this.pimiHome = options.pimiHome;
    this.getAgentProfiles = options.getAgentProfiles;
    this.gh = options.gh;
    this.compileDefinition = options.compile;
    this.store = new AutomationStore({
      database: options.database,
      legacyDir: join(options.pimiHome, "automations"),
      logger: this.logger,
    });
    this.audit = new AutomationAuditLog({ database: options.database, logger: this.logger });
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
    await rm(join(this.pimiHome, "schedules"), { recursive: true, force: true });
    await this.store.importLegacy();
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

  compile(input: { description: string; cwd: string }): Promise<AutomationDefinition> {
    return this.compileDefinition(input);
  }

  // Compiling takes an LLM turn, so a draft records the request and the turn runs in the
  // background. Success saves a pending automation (origin `compiled`) and the draft names it;
  // failure keeps the reason on the draft for a retry.
  async startDraft(input: { description: string; cwd: string }): Promise<AutomationDraft> {
    const description = input.description.trim();
    if (!description) {
      throw new Error("Describe the automation first");
    }
    const now = new Date().toISOString();
    const draft = await this.store.drafts.put({
      id: randomBytes(4).toString("hex"),
      description,
      cwd: input.cwd,
      state: "drafting",
      error: null,
      automationId: null,
      createdAt: now,
      updatedAt: now,
    });
    this.notifyDraftsChanged();
    this.compileDraft(draft);
    return draft;
  }

  /** Calls `listener` after any draft is added, changed or dismissed. */
  onDraftsChanged(listener: () => void): () => void {
    this.draftListeners.add(listener);
    return () => this.draftListeners.delete(listener);
  }

  private notifyDraftsChanged(): void {
    for (const listener of this.draftListeners) {
      try {
        listener();
      } catch (caught) {
        this.logger.warn({ err: caught }, "Automation draft listener failed");
      }
    }
  }

  async listDrafts(): Promise<AutomationDraft[]> {
    const now = Date.now();
    const drafts: AutomationDraft[] = [];
    for (const draft of await this.store.drafts.list()) {
      const retentionMs = DRAFT_RETENTION_MS[draft.state];
      if (retentionMs !== null && new Date(draft.updatedAt).getTime() < now - retentionMs) {
        await this.store.drafts.delete(draft.id);
        continue;
      }
      drafts.push(draft);
    }
    return drafts.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async retryDraft(id: string): Promise<AutomationDraft> {
    // The state check lives in the update, which the store serializes, so two retries cannot
    // both see "failed" and start two compiles.
    const draft = requireFound(
      await this.store.drafts.update(id, (current) => {
        if (current.state !== "failed") {
          throw new AutomationStateError(`Draft ${id} is ${current.state}, not failed`);
        }
        return {
          ...current,
          state: "drafting",
          error: null,
          updatedAt: new Date().toISOString(),
        };
      }),
      id,
    );
    this.notifyDraftsChanged();
    this.compileDraft(draft);
    return draft;
  }

  // Dismissing a draft that is still compiling drops its result when the turn ends.
  async dismissDraft(id: string): Promise<void> {
    await this.store.drafts.delete(id);
    this.notifyDraftsChanged();
  }

  private compileDraft(draft: AutomationDraft): void {
    void (async () => {
      let automationId: string | null = null;
      let error: string | null = null;
      try {
        const definition = await this.compileDefinition({
          description: draft.description,
          cwd: draft.cwd,
        });
        if (!(await this.store.drafts.get(draft.id))) {
          return;
        }
        automationId = (await this.create({ definition, origin: { kind: "compiled" } })).id;
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
        this.logger.warn({ err: caught, draftId: draft.id }, "Automation draft failed to compile");
      }
      await this.store.drafts.update(draft.id, (current) => ({
        ...current,
        state: automationId ? "ready" : "failed",
        error,
        automationId,
        updatedAt: new Date().toISOString(),
      }));
      this.notifyDraftsChanged();
    })().catch((caught) => {
      this.logger.error({ err: caught, draftId: draft.id }, "Failed to record automation draft");
    });
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

  // A user's automation is active at once. An agent's, or one the owner saved from a compiled
  // draft, waits in `pending` for the owner. Creating one with the name of one the same agent
  // already made replaces it and puts it back in `pending`.
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
            await this.resetTriggerState(replaced.id);
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
    return this.insert(fields, origin, origin.kind === "compiled" ? "pending" : "active", now);
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
      triggerCheck: null,
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

  // An agent's edit sends the automation back to `pending` until the owner approves it again.
  async update(input: {
    id: string;
    definition: AutomationDefinition;
    actor: AutomationActor;
  }): Promise<Automation> {
    const fields = normalizeDefinition(input.definition, this.getAgentProfiles());
    const now = new Date();
    const needsApproval = input.actor.kind === "agent";
    let triggerChanged = false;
    const updated = await this.store.automations.update(input.id, (current) => {
      if (current.status === "ended") {
        throw new AutomationStateError(`Automation ${input.id} has ended`);
      }
      triggerChanged = !sameTrigger(current.trigger, fields.trigger);
      const next: Automation = {
        ...current,
        ...fields,
        ...(needsApproval ? { status: "pending" as const, pausedReason: null } : {}),
        triggerCheck: triggerChanged ? null : current.triggerCheck,
        revision: current.revision + 1,
        updatedAt: now.toISOString(),
      };
      next.nextRunAt = scheduledNextRunAt(next, now);
      return next;
    });
    const automation = requireFound(updated, input.id);
    if (triggerChanged || needsApproval) {
      await this.resetTriggerState(automation.id);
    }
    await this.audit.append({
      automationId: automation.id,
      action: "updated",
      actor: input.actor,
      runId: null,
      detail: needsApproval
        ? `revision ${automation.revision}; waiting for approval`
        : `revision ${automation.revision}`,
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

  // Becoming active starts the pull-request trigger from a fresh look at the open PRs, so what
  // changed while it waited or was paused does not all fire at once.
  async approve(id: string, actor: AutomationActor): Promise<Automation> {
    await this.resetTriggerState(id);
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
    const automation = await this.transition(id, actor, "enabled", (current, now) => {
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
    await this.resetTriggerState(id);
    return automation;
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

  private async resetTriggerState(id: string): Promise<void> {
    await this.store.triggerStates.delete(id);
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

  private assertRunnable(automation: Automation, actor: AutomationActor): void {
    const id = automation.id;
    if (automation.status === "pending") {
      throw new AutomationStateError(`Automation ${id} is waiting for approval`);
    }
    if (automation.status === "ended") {
      throw new AutomationStateError(`Automation ${id} has ended`);
    }
    if (actor.kind === "agent" && automation.status !== "active") {
      throw new AutomationStateError(`Automation ${id} is paused`);
    }
  }

  // Starts a run now and returns it while it is still running.
  async startManualRun(id: string, actor: AutomationActor): Promise<AutomationRun> {
    const automation = await this.get(id);
    this.assertRunnable(automation, actor);
    return this.admit(async () => {
      const refusal = await this.admissionRefusal(automation, new Date());
      if (refusal) {
        throw new AutomationStateError(refusal);
      }
      return this.startRun(automation, { kind: "manual", actor }, actor);
    });
  }

  // Starts a new run that reruns the steps of a finished run that did not succeed, with the
  // automation as it is now. Steps that succeeded keep their output and are not run again.
  async retryRun(
    automationId: string,
    runId: string,
    actor: AutomationActor,
  ): Promise<AutomationRun> {
    const automation = await this.get(automationId);
    this.assertRunnable(automation, actor);
    const source = await this.getRun(automationId, runId);
    if (source.status === "running") {
      throw new AutomationStateError(`Run ${runId} is still running`);
    }
    if (source.status === "succeeded") {
      throw new AutomationStateError(`Run ${runId} succeeded; there is nothing to retry`);
    }
    return this.admit(async () => {
      const refusal = await this.admissionRefusal(automation, new Date());
      if (refusal) {
        throw new AutomationStateError(refusal);
      }
      return this.startRun(automation, { kind: "retry", actor, runId }, actor, source);
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
    return this.finishRun({
      automationId,
      runId,
      status: "cancelled",
      error: null,
      reportAgentId: run.reportAgentId,
    });
  }

  private stopRun(runId: string, reason: "cancelled" | "timed_out"): void {
    const active = this.activeRuns.get(runId);
    if (!active || active.handle.stopReason) {
      return;
    }
    active.handle.stopReason = reason;
    for (const step of active.handle.steps) {
      step.stopReason ??= reason;
      const agentId = step.agentId;
      if (agentId) {
        void this.engine.agentManager.cancelAgentRun(agentId).catch((error: unknown) => {
          this.logger.warn({ err: error, runId, agentId }, "Failed to cancel automation agent");
        });
      }
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
    retryOf?: AutomationRun,
  ): Promise<AutomationRun> {
    const order = topologicalOrder(automation.flow);
    if (!order) {
      throw new AutomationStateError(`Automation ${automation.id} has a flow this host cannot run`);
    }
    const now = new Date().toISOString();
    const runId = randomUUID();
    const run: AutomationRun = {
      id: runId,
      automationId: automation.id,
      revision: automation.revision,
      cause,
      dedupeKey: dedupeKeyFor(cause, runId),
      status: "running",
      unread: true,
      startedAt: now,
      endedAt: null,
      reportAgentId: null,
      reportWorkspaceId: null,
      steps: retryOf ? retrySteps(automation, retryOf) : order.map(pendingStep),
      error: null,
    };
    const handle: RunHandle = { stopReason: null, steps: new Set() };
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
      detail: describeCause(cause),
    });
    void this.execute(automation, run, handle).finally(() => {
      this.activeRuns.delete(runId);
    });
    return run;
  }

  private async execute(automation: Automation, run: AutomationRun, handle: RunHandle) {
    const timer = setTimeout(
      () => this.stopRun(run.id, "timed_out"),
      automation.limits.maxRuntimeMs,
    );
    timer.unref?.();
    const runs = this.store.runs(automation.id);
    const opened: RunWorkspace[] = [];
    let deleted = false;
    const updateRun = async (apply: (current: AutomationRun) => AutomationRun) => {
      if (deleted) {
        return;
      }
      // Deleting an automation removes its run records; writing would recreate the directory.
      if ((await this.store.automations.get(automation.id)) === null) {
        deleted = true;
        return;
      }
      await runs.update(run.id, apply);
    };
    const updateStep = (nodeId: string, patch: StepPatch) =>
      updateRun((current) => ({
        ...current,
        steps: current.steps.map((step) => (step.nodeId === nodeId ? { ...step, ...patch } : step)),
      }));
    let result: Awaited<ReturnType<typeof runFlow>>;
    try {
      result = await runFlow(this.engine, {
        automation,
        run,
        handle,
        pullRequest:
          run.cause.kind === "trigger" && run.cause.event.kind === "pull_request"
            ? run.cause.event
            : await this.retriedPullRequest(automation.id, run),
        updateStep,
        onWorkspace: async (workspace) => {
          opened.push(workspace);
          await updateRun((current) => ({
            ...current,
            reportWorkspaceId: current.reportWorkspaceId ?? workspace.workspaceId,
          }));
        },
      });
    } catch (cause) {
      result = {
        status: "failed",
        error: cause instanceof Error ? cause.message : String(cause),
        reportAgentId: null,
      };
    } finally {
      clearTimeout(timer);
    }
    try {
      const record = deleted ? null : await runs.get(run.id);
      // A workspace no step started an agent in has nothing to report.
      const empty = opened.filter(
        (workspace) =>
          !record?.steps.some(
            (step) =>
              step.workspaceId === workspace.workspaceId && step.agentId && !step.reusedFrom,
          ),
      );
      for (const workspace of deleted ? opened : empty) {
        this.archiveWorkspace(workspace.workspaceId, !workspace.createdWorktree);
      }
      if (deleted || (await this.store.automations.get(automation.id)) === null) {
        return;
      }
      await this.finishRun({
        automationId: automation.id,
        runId: run.id,
        status: result.status,
        error: result.error,
        reportAgentId: result.reportAgentId,
      });
    } catch (finishError) {
      this.logger.error(
        { err: finishError, automationId: automation.id, runId: run.id },
        "Failed to record automation run result",
      );
    }
  }

  // A retry of a pull-request run reads the same pull request as the run it retries.
  private async retriedPullRequest(
    automationId: string,
    run: AutomationRun,
  ): Promise<AutomationPullRequestEvent | null> {
    let cause = run.cause;
    const seen = new Set<string>();
    while (cause.kind === "retry" && !seen.has(cause.runId)) {
      seen.add(cause.runId);
      const source = await this.store.runs(automationId).get(cause.runId);
      if (!source) {
        return null;
      }
      cause = source.cause;
    }
    return cause.kind === "trigger" && cause.event.kind === "pull_request" ? cause.event : null;
  }

  private async finishRun(input: {
    automationId: string;
    runId: string;
    status: Exclude<AutomationRunStatus, "running">;
    error: string | null;
    reportAgentId: string | null;
  }): Promise<AutomationRun> {
    const endedAt = new Date().toISOString();
    const run = await this.store.runs(input.automationId).update(input.runId, (current) => ({
      ...current,
      status: input.status,
      endedAt,
      error: input.error,
      reportAgentId: input.reportAgentId ?? current.reportAgentId,
      // A step still open when the run ends (a run cancelled before it started) never ran.
      steps: current.steps.map((step) =>
        step.status === "pending" || step.status === "running"
          ? { ...step, status: "cancelled", endedAt }
          : step,
      ),
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

  private archiveWorkspace(workspaceId: string, keepDirectory: boolean): void {
    this.archiveQueue = this.archiveQueue.then(() =>
      this.archiveEach(new Map([[workspaceId, keepDirectory]])),
    );
  }

  // Archives the workspaces of runs whose records are gone, with their agents. A worktree goes
  // too only when the run created it; a project directory or worktree the run opened in stays
  // untouched. A step a retry reused belongs to the run that ran it. Runs one at a time in the
  // background: archiving touches git and should not hold up the caller.
  private archiveRunWorkspaces(runs: readonly AutomationRun[]): void {
    // workspaceId -> keepDirectory
    const workspaces = new Map<string, boolean>();
    for (const run of runs) {
      for (const step of run.steps) {
        if (step.workspaceId && !step.reusedFrom) {
          workspaces.set(
            step.workspaceId,
            (workspaces.get(step.workspaceId) ?? true) && step.createdWorktree !== true,
          );
        }
      }
      const reused = new Set(run.steps.filter((step) => step.reusedFrom).map((s) => s.workspaceId));
      if (
        run.reportWorkspaceId &&
        !workspaces.has(run.reportWorkspaceId) &&
        !reused.has(run.reportWorkspaceId)
      ) {
        workspaces.set(run.reportWorkspaceId, true);
      }
    }
    if (workspaces.size === 0) {
      return;
    }
    this.archiveQueue = this.archiveQueue.then(() => this.archiveEach(workspaces));
  }

  private async archiveEach(workspaces: ReadonlyMap<string, boolean>): Promise<void> {
    for (const [workspaceId, keepDirectory] of workspaces) {
      try {
        await this.engine.archiveWorkspace(workspaceId, { keepDirectory });
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
        if (automation.trigger.kind === "pull_request") {
          const lastCheck = automation.triggerCheck?.at;
          if (
            !this.polling.has(automation.id) &&
            (!lastCheck ||
              now.getTime() - new Date(lastCheck).getTime() >= PULL_REQUEST_POLL_INTERVAL_MS)
          ) {
            // Polls run beside the tick so a slow gh call does not hold up schedules.
            void this.pollTrigger(automation.id).catch((error: unknown) => {
              this.logger.warn(
                { err: error, automationId: automation.id },
                "PR trigger poll failed",
              );
            });
          }
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

  // Polls a pull-request trigger now. Returns the runs it started.
  async checkTrigger(id: string): Promise<{ automation: Automation; started: AutomationRun[] }> {
    const automation = await this.get(id);
    if (automation.trigger.kind !== "pull_request") {
      throw new AutomationStateError(`Automation ${id} has no pull request trigger`);
    }
    if (automation.status !== "active") {
      throw new AutomationStateError(`Automation ${id} is ${automation.status}`);
    }
    const started = await this.pollTrigger(id);
    return { automation: await this.get(id), started };
  }

  private pollTrigger(id: string): Promise<AutomationRun[]> {
    const inFlight = this.polling.get(id);
    if (inFlight) {
      return inFlight;
    }
    const poll = this.pollTriggerOnce(id).finally(() => this.polling.delete(id));
    this.polling.set(id, poll);
    return poll;
  }

  private async pollTriggerOnce(id: string): Promise<AutomationRun[]> {
    const automation = await this.get(id);
    const trigger = automation.trigger;
    if (trigger.kind !== "pull_request" || automation.status !== "active") {
      return [];
    }
    const at = new Date().toISOString();
    let events: AutomationPullRequestEvent[];
    try {
      const result = await pollPullRequests({
        gh: this.gh,
        automationId: id,
        repo: trigger.repo,
        events: trigger.events,
        previous: await this.store.triggerStates.get(id),
      });
      // The state is saved before any run starts: a head is spent once seen, even when the run
      // is then skipped for a limit, the same as a skipped schedule slot.
      await this.store.triggerStates.put(result.state);
      events = result.events;
      await this.store.automations.update(id, (current) => ({
        ...current,
        triggerCheck: { at, error: null },
      }));
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      await this.store.automations.update(id, (current) => ({
        ...current,
        triggerCheck: { at, error: message },
      }));
      throw error;
    }
    const started: AutomationRun[] = [];
    for (const event of events) {
      const run = await this.fireEvent(id, { kind: "trigger", event }, new Date());
      if (run) {
        started.push(run);
      }
    }
    return started;
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
    const slot: string = scheduledFor;
    await this.fireEvent(
      id,
      { kind: "trigger", event: { kind: "schedule", scheduledFor: slot } },
      now,
    );
  }

  // Starts a triggered run unless a limit refuses it; a refused trigger is skipped, not queued.
  private async fireEvent(
    id: string,
    cause: Extract<AutomationRunCause, { kind: "trigger" }>,
    now: Date,
  ): Promise<AutomationRun | null> {
    const daemon: AutomationActor = { kind: "daemon" };
    return this.admit(async () => {
      const automation = await this.store.automations.get(id);
      if (!automation || automation.status !== "active") {
        return null;
      }
      const refusal = await this.admissionRefusal(automation, now);
      if (refusal) {
        await this.audit.append({
          automationId: id,
          action: "run_skipped",
          actor: daemon,
          runId: null,
          detail: `${describeCause(cause)}: ${refusal}`.slice(0, 300),
        });
        return null;
      }
      try {
        return await this.startRun(automation, cause, daemon);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error({ err: error, automationId: id }, "Failed to start triggered run");
        await this.audit.append({
          automationId: id,
          action: "run_skipped",
          actor: daemon,
          runId: null,
          detail: `could not start: ${message}`.slice(0, 300),
        });
        return null;
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
    for (const draft of await this.store.drafts.list()) {
      if (draft.state === "drafting") {
        await this.store.drafts.update(draft.id, (current) => ({
          ...current,
          state: "failed",
          error: "The daemon restarted before the draft was ready",
          updatedAt: now.toISOString(),
        }));
      }
    }
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
          steps: current.steps.map((step) => {
            if (step.status === "running") {
              return { ...step, status: "failed", endedAt, error };
            }
            return step.status === "pending" ? { ...step, status: "cancelled", endedAt } : step;
          }),
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
