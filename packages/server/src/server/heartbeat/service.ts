import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Logger } from "pino";
import {
  HeartbeatSchema,
  type Heartbeat,
  type HeartbeatCadence,
} from "@pimi/protocol/heartbeat/types";
import { formatSystemNotificationPrompt } from "../agent/agent-messages/index.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { ensureAgentLoaded } from "../agent/agent-loading.js";
import { startAgentRun, type AgentRunController } from "../agent/agent-prompt.js";
import { computeNextRunAt, validateCadence, withHostTimeZone } from "../automation/cron.js";
import { JsonRecordStore } from "../json-record-store.js";

const HEARTBEAT_TICK_INTERVAL_MS = 1000;
// Every fire is an agent turn, and a fire while the agent is busy fails. Below 30 seconds an
// interval mostly produces failed fires and wakeups that cost tokens without doing work.
export const MIN_HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_HEARTBEAT_PROMPT_LENGTH = 100_000;

export class HeartbeatNotFoundError extends Error {
  constructor(id: string) {
    super(`Heartbeat not found: ${id}`);
    this.name = "HeartbeatNotFoundError";
  }
}

export interface CreateHeartbeatInput {
  agentId: string;
  name?: string | null;
  prompt: string;
  cadence: HeartbeatCadence;
  maxRuns?: number | null;
  expiresAt?: string | null;
  runOnCreate?: boolean | null;
}

type HeartbeatAgentManager = AgentRunController &
  Pick<
    AgentManager,
    | "createAgent"
    | "getRegisteredProviderIds"
    | "hydrateTimelineFromProvider"
    | "resumeAgentFromPersistence"
    | "waitForAgentEvent"
    | "waitForAgentClose"
    | "closeAgent"
  >;

export interface HeartbeatServiceOptions {
  pimiHome: string;
  logger: Logger;
  agentManager: HeartbeatAgentManager;
  agentStorage: AgentStorage;
}

function trimOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function validateHeartbeatCadence(cadence: HeartbeatCadence): void {
  if (cadence.type === "once") {
    if (Number.isNaN(new Date(cadence.at).getTime())) {
      throw new Error(`Invalid heartbeat time: ${cadence.at}`);
    }
    return;
  }
  if (cadence.type === "every" && cadence.everyMs < MIN_HEARTBEAT_INTERVAL_MS) {
    throw new Error(
      `Heartbeat interval must be at least ${MIN_HEARTBEAT_INTERVAL_MS / 1000} seconds`,
    );
  }
  validateCadence(cadence);
}

// The first fire time. `every` starts one interval from now unless runOnCreate.
function firstRunAt(cadence: HeartbeatCadence, now: Date, runOnCreate: boolean): Date {
  if (cadence.type === "once") {
    return new Date(cadence.at);
  }
  return runOnCreate ? now : computeNextRunAt(cadence, now);
}

// The next fire after a fire, skipping slots already past. A one-time heartbeat has none.
function advancePast(cadence: HeartbeatCadence, from: Date, now: Date): Date | null {
  if (cadence.type === "once") {
    return null;
  }
  let next = from;
  while (next.getTime() <= now.getTime()) {
    next = computeNextRunAt(cadence, next);
  }
  return next;
}

function isoOrNull(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

function hasEnded(heartbeat: Heartbeat, now: Date): boolean {
  if (heartbeat.expiresAt && new Date(heartbeat.expiresAt).getTime() <= now.getTime()) {
    return true;
  }
  if (heartbeat.cadence.type === "once" && heartbeat.runCount >= 1) {
    return true;
  }
  return heartbeat.maxRuns !== null && heartbeat.runCount >= heartbeat.maxRuns;
}

function buildHeartbeatPrompt(heartbeat: Heartbeat): string {
  const heading = heartbeat.name
    ? `Heartbeat "${heartbeat.name}" fired (id=${heartbeat.id}).`
    : `Heartbeat fired (id=${heartbeat.id}).`;
  return formatSystemNotificationPrompt(`${heading}\n${heartbeat.prompt}`);
}

// Heartbeats send a prompt back into an existing agent on a cadence. They need no approval
// (the agent schedules work for itself) and are deleted when they end or their agent goes.
export class HeartbeatService {
  private readonly store: JsonRecordStore<Heartbeat>;
  private readonly logger: Logger;
  private readonly agentManager: HeartbeatAgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly running = new Set<string>();
  private readonly identityLocks = new Map<string, Promise<unknown>>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: HeartbeatServiceOptions) {
    this.logger = options.logger.child({ module: "heartbeat-service" });
    this.store = new JsonRecordStore({
      dir: join(options.pimiHome, "heartbeats"),
      schema: HeartbeatSchema,
      logger: this.logger,
      label: "heartbeat",
    });
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
  }

  async start(): Promise<void> {
    await this.recover();
    if (this.tickTimer) {
      return;
    }
    const timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.logger.error({ err: error }, "Failed to process heartbeat tick");
      });
    }, HEARTBEAT_TICK_INTERVAL_MS);
    timer.unref?.();
    this.tickTimer = timer;
  }

  async stop(): Promise<void> {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  async list(agentId?: string): Promise<Heartbeat[]> {
    const heartbeats = await this.store.list();
    return heartbeats
      .filter((heartbeat) => agentId === undefined || heartbeat.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async get(id: string): Promise<Heartbeat> {
    const heartbeat = await this.store.get(id);
    if (!heartbeat) {
      throw new HeartbeatNotFoundError(id);
    }
    return heartbeat;
  }

  // Creating a heartbeat with the name of one the agent already has replaces it, so an agent
  // can re-register its heartbeat without making duplicates.
  async createOrReplace(request: CreateHeartbeatInput): Promise<Heartbeat> {
    const input = { ...request, cadence: withHostTimeZone(request.cadence) };
    const prompt = input.prompt.trim();
    if (!prompt) {
      throw new Error("Heartbeat prompt is required");
    }
    if (prompt.length > MAX_HEARTBEAT_PROMPT_LENGTH) {
      throw new Error(`Heartbeat prompt is longer than ${MAX_HEARTBEAT_PROMPT_LENGTH} characters`);
    }
    validateHeartbeatCadence(input.cadence);
    // An unparseable expiry never compares as past, so the heartbeat would never end.
    if (input.expiresAt != null && Number.isNaN(new Date(input.expiresAt).getTime())) {
      throw new Error(`Invalid heartbeat expiry: ${input.expiresAt}`);
    }
    if (input.maxRuns != null && (!Number.isInteger(input.maxRuns) || input.maxRuns <= 0)) {
      throw new Error("maxRuns must be a positive integer");
    }
    const record = await this.agentStorage.get(input.agentId);
    if (!record || record.archivedAt) {
      throw new Error(`Agent ${input.agentId} does not exist or is archived`);
    }
    const name = trimOptional(input.name);
    const now = new Date();
    const runOnCreate = input.runOnCreate ?? false;
    const nextRunAt = firstRunAt(input.cadence, now, runOnCreate).toISOString();
    const fields = {
      agentId: input.agentId,
      name,
      prompt,
      cadence: input.cadence,
      updatedAt: now.toISOString(),
      nextRunAt,
      expiresAt: input.expiresAt ?? null,
      maxRuns: input.maxRuns ?? null,
    };
    const create = () =>
      this.store.put({
        ...fields,
        id: randomBytes(4).toString("hex"),
        createdAt: now.toISOString(),
        runCount: 0,
        lastRun: null,
      });
    if (name === null) {
      return create();
    }
    return this.withIdentityLock(`${input.agentId}\u0000${name}`, async () => {
      const existing = (await this.store.list()).find(
        (heartbeat) => heartbeat.agentId === input.agentId && heartbeat.name === name,
      );
      if (!existing) {
        return create();
      }
      const replaced = await this.store.update(existing.id, (current) => ({
        ...current,
        ...fields,
        runCount: 0,
      }));
      return replaced ?? create();
    });
  }

  async updateCadence(id: string, requested: HeartbeatCadence): Promise<Heartbeat> {
    const cadence = withHostTimeZone(requested);
    validateHeartbeatCadence(cadence);
    const updated = await this.store.update(id, (current) => {
      const now = new Date();
      return {
        ...current,
        cadence,
        nextRunAt: firstRunAt(cadence, now, false).toISOString(),
        runCount: cadence.type === "once" ? 0 : current.runCount,
        updatedAt: now.toISOString(),
      };
    });
    if (!updated) {
      throw new HeartbeatNotFoundError(id);
    }
    return updated;
  }

  async delete(id: string): Promise<void> {
    await this.store.delete(id);
  }

  async deleteForAgent(agentId: string): Promise<number> {
    const matches = (await this.store.list()).filter((heartbeat) => heartbeat.agentId === agentId);
    await Promise.all(matches.map((heartbeat) => this.store.delete(heartbeat.id)));
    return matches.length;
  }

  private async recover(): Promise<void> {
    const now = new Date();
    for (const heartbeat of await this.store.list()) {
      const record = await this.agentStorage.get(heartbeat.agentId);
      if (!record || record.archivedAt || hasEnded(heartbeat, now)) {
        await this.store.delete(heartbeat.id);
        continue;
      }
      if (
        heartbeat.cadence.type !== "once" &&
        heartbeat.nextRunAt &&
        new Date(heartbeat.nextRunAt).getTime() <= now.getTime()
      ) {
        await this.store.update(heartbeat.id, (current) => ({
          ...current,
          nextRunAt: isoOrNull(advancePast(current.cadence, new Date(heartbeat.nextRunAt!), now)),
          updatedAt: now.toISOString(),
        }));
      }
    }
  }

  async tick(): Promise<void> {
    const now = new Date();
    for (const heartbeat of await this.store.list()) {
      if (this.running.has(heartbeat.id)) {
        continue;
      }
      if (hasEnded(heartbeat, now)) {
        await this.store.delete(heartbeat.id);
        continue;
      }
      if (!heartbeat.nextRunAt || new Date(heartbeat.nextRunAt).getTime() > now.getTime()) {
        continue;
      }
      // A one-time heartbeat waits for its agent to finish its turn instead of failing.
      if (
        heartbeat.cadence.type === "once" &&
        this.agentManager.hasInFlightRun(heartbeat.agentId)
      ) {
        continue;
      }
      this.running.add(heartbeat.id);
      void this.fire(heartbeat.id, now)
        .catch((error) => {
          this.logger.error({ err: error, heartbeatId: heartbeat.id }, "Heartbeat run failed");
        })
        .finally(() => {
          this.running.delete(heartbeat.id);
        });
    }
  }

  private async fire(id: string, now: Date): Promise<void> {
    // Advance the cursor before running so a long turn cannot fire the same slot twice.
    let due = false;
    const claimed = await this.store.update(id, (current) => {
      if (!current.nextRunAt || new Date(current.nextRunAt).getTime() > now.getTime()) {
        return current;
      }
      due = true;
      return {
        ...current,
        nextRunAt: isoOrNull(advancePast(current.cadence, new Date(current.nextRunAt), now)),
        runCount: current.runCount + 1,
        updatedAt: now.toISOString(),
      };
    });
    if (!claimed || !due) {
      return;
    }
    const record = await this.agentStorage.get(claimed.agentId);
    if (!record || record.archivedAt) {
      await this.store.delete(id);
      return;
    }
    let error: string | null = null;
    try {
      await this.sendToAgent(claimed);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      // A one-time or last fire is deleted below, taking `lastRun` with it; the log keeps why.
      this.logger.warn(
        { err: cause, heartbeatId: id, agentId: claimed.agentId },
        "Heartbeat fire failed",
      );
    }
    const finished = await this.store.update(id, (current) => ({
      ...current,
      lastRun: { at: now.toISOString(), status: error ? "failed" : "succeeded", error },
    }));
    if (finished && hasEnded(finished, new Date())) {
      await this.store.delete(id);
    }
  }

  private async sendToAgent(heartbeat: Heartbeat): Promise<void> {
    const agent = await ensureAgentLoaded(heartbeat.agentId, {
      agentManager: this.agentManager,
      agentStorage: this.agentStorage,
      logger: this.logger,
    });
    if (this.agentManager.hasInFlightRun(agent.id)) {
      throw new Error(`Agent ${agent.id} already has an active run`);
    }
    await startAgentRun(this.agentManager, agent.id, buildHeartbeatPrompt(heartbeat), this.logger, {
      replaceRunning: true,
      activeTurnBehavior: "steer",
    });
    const result = await this.agentManager.waitForAgentEvent(agent.id, { waitForActive: true });
    if (result.permission) {
      throw new Error(`Agent ${agent.id} is waiting for permission`);
    }
    if (result.status === "error") {
      throw new Error(result.lastMessage ?? `Agent ${agent.id} failed`);
    }
  }

  private async withIdentityLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.identityLocks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.identityLocks.set(key, next);
    try {
      return await next;
    } finally {
      if (this.identityLocks.get(key) === next) {
        this.identityLocks.delete(key);
      }
    }
  }
}
