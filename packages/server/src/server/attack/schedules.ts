import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import treeKill from "tree-kill";
import type { Logger } from "pino";
import {
  AttackScheduleAuditEntrySchema,
  AttackScheduleSchema,
  type AttackRun,
  type AttackSchedule,
  type AttackScheduleAuditEntry,
  type AttackScheduleInput,
  type AttackScheduleOutcome,
  ATTACK_ROLE_REQUIREMENTS,
} from "@pimi/protocol/attack/types";
import type { AutomationPullRequestEvent } from "@pimi/protocol/automation/types";
import { SqlAuditLog, SqlRecordStore } from "../db/sql-record-store.js";
import type { PimiDatabase } from "../db/pimi-db.js";
import { computeNextRunAt, validateCadence, withHostTimeZone } from "../automation/cron.js";
import {
  PULL_REQUEST_POLL_INTERVAL_MS,
  PullRequestTriggerStateSchema,
  pollPullRequests,
  type GhRunner,
  type PullRequestTriggerState,
} from "../automation/pull-request-trigger.js";
import type { PushNotificationSender } from "../push/index.js";
import { spawnProcess } from "../../utils/spawn.js";
import { AttackStateError, type AttackService } from "./service.js";

const TICK_INTERVAL_MS = 15_000;
/** How long a fire waits for the target's health URL before it is skipped. */
export const SCHEDULE_HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_POLL_MS = 1_000;
const HEALTH_REQUEST_TIMEOUT_MS = 3_000;
const AUDIT_READ_LIMIT = 10;
const MAX_SCHEDULES = 50;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface AttackSchedulerOptions {
  database: PimiDatabase;
  logger: Logger;
  attackService: AttackService;
  /** Runs the host's `gh` CLI for pull-request triggers. */
  gh: GhRunner;
  /** Tells the owner a scheduled run ended with blockers. Absent when no device is paired. */
  notify?: PushNotificationSender;
  /** Test seam: whether the URL answers. */
  isHealthy?: (url: string) => Promise<boolean>;
}

interface WatchedRun {
  scheduleId: string;
  child: ChildProcess | null;
}

async function defaultIsHealthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
    });
    await response.body?.cancel();
    // Any answer below 500 means a server is up; the run itself will find what is wrong with it.
    return response.status < 500;
  } catch {
    return false;
  }
}

function killTree(pid: number): void {
  treeKill(pid, "SIGTERM", () => undefined);
}

function parseHttpUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AttackStateError(`${label} is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AttackStateError(`${label} must be an http or https URL.`);
  }
  return url;
}

function pullRequestScopeNotes(base: string, event: AutomationPullRequestEvent): string {
  const title = event.title.replaceAll(/\s+/g, " ").slice(0, 120);
  const context =
    `Triggered by pull request #${event.number} "${title}" (${event.url}), head ${event.headRef}. ` +
    "The target below is the app that is already running; Pimi did not check the pull request out.";
  return base ? `${context}\n${base}` : context;
}

/**
 * Saved Attack runs fired by a trigger: a cadence, a pull request on GitHub, or the owner's "Run
 * now". An unattended run needs a target that is already up, so every fire first checks the
 * schedule's health URL (starting its start command when the URL is down) and is skipped, with an
 * audit entry, when the URL is not healthy within SCHEDULE_HEALTH_TIMEOUT_MS. A run that ends with
 * blockers posts nothing by itself: the owner is notified. Pull-request runs are always read-only
 * and never disposable. One live run per workspace still holds: a fire while one is live is
 * skipped, not queued.
 */
export class AttackScheduler {
  private readonly logger: Logger;
  private readonly attack: AttackService;
  private readonly gh: GhRunner;
  private readonly notify: PushNotificationSender | undefined;
  private readonly isHealthy: (url: string) => Promise<boolean>;
  private readonly schedules: SqlRecordStore<AttackSchedule>;
  private readonly triggerStates: SqlRecordStore<PullRequestTriggerState>;
  private readonly database: PimiDatabase;
  private readonly firing = new Set<string>();
  private readonly polling = new Set<string>();
  private readonly lastPollAt = new Map<string, number>();
  private readonly watched = new Map<string, WatchedRun>();
  private readonly startedChildren = new Set<ChildProcess>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(options: AttackSchedulerOptions) {
    this.logger = options.logger.child({ module: "attack-schedules" });
    this.attack = options.attackService;
    this.gh = options.gh;
    this.notify = options.notify;
    this.isHealthy = options.isHealthy ?? defaultIsHealthy;
    this.database = options.database;
    this.schedules = new SqlRecordStore({
      database: options.database,
      kind: "attack_schedule",
      schema: AttackScheduleSchema,
      logger: this.logger,
      label: "attack schedule",
    });
    this.triggerStates = new SqlRecordStore({
      database: options.database,
      kind: "attack_schedule_trigger",
      schema: PullRequestTriggerStateSchema,
      logger: this.logger,
      label: "attack schedule trigger state",
    });
  }

  async start(): Promise<void> {
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        this.logger.error({ err: error }, "Attack schedule tick failed");
      });
    }, TICK_INTERVAL_MS);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const child of this.startedChildren) if (child.pid) killTree(child.pid);
    this.startedChildren.clear();
  }

  // ---- owner actions ----

  async list(workspaceId?: string): Promise<{
    schedules: AttackSchedule[];
    audit: AttackScheduleAuditEntry[];
  }> {
    const schedules = (await this.schedules.list()).filter(
      (schedule) => !workspaceId || schedule.workspaceId === workspaceId,
    );
    return {
      schedules,
      audit: schedules.flatMap((schedule) => this.auditLog(schedule.id).read(AUDIT_READ_LIMIT)),
    };
  }

  async save(input: AttackScheduleInput): Promise<AttackSchedule> {
    const now = new Date();
    const existing = input.id ? await this.schedules.get(input.id) : null;
    if (input.id && !existing) throw new AttackStateError(`Schedule not found: ${input.id}`);
    if (!existing && (await this.schedules.list()).length >= MAX_SCHEDULES) {
      throw new AttackStateError(`At most ${MAX_SCHEDULES} schedules are kept.`);
    }
    const checked = this.validate(input);
    const nextFireAt =
      checked.enabled && checked.trigger.kind === "schedule"
        ? computeNextRunAt(checked.trigger.cadence, now).toISOString()
        : null;
    const schedule: AttackSchedule = {
      ...checked,
      id: existing?.id ?? randomUUID().replaceAll("-", ""),
      nextFireAt,
      lastFiredAt: existing?.lastFiredAt ?? null,
      createdAt: existing?.createdAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
    };
    // Changing a pull-request trigger starts its polling afresh, so the first poll records what is
    // open and does not fire for every pull request already waiting.
    await this.triggerStates.delete(schedule.id);
    return this.schedules.put(schedule);
  }

  async remove(scheduleId: string): Promise<void> {
    await this.schedules.delete(scheduleId);
    await this.triggerStates.delete(scheduleId);
    this.database.db
      .prepare("DELETE FROM audit WHERE scope = ?")
      .run(`attack_schedule:${scheduleId}`);
  }

  async runNow(scheduleId: string): Promise<AttackScheduleAuditEntry> {
    const schedule = await this.schedules.get(scheduleId);
    if (!schedule) throw new AttackStateError(`Schedule not found: ${scheduleId}`);
    return this.fire(schedule, null);
  }

  // ---- validation ----

  private validate(
    input: AttackScheduleInput,
  ): Omit<AttackSchedule, "id" | "nextFireAt" | "lastFiredAt" | "createdAt" | "updatedAt"> {
    const target = parseHttpUrl(input.definition.target, "The target");
    const health = parseHttpUrl(input.healthUrl, "The health URL");
    // The daemon requests the health URL itself: it stays on the target's host.
    if (health.hostname !== target.hostname) {
      throw new AttackStateError("The health URL must be on the target's host.");
    }
    const trigger = input.trigger;
    if (trigger.kind === "schedule") {
      validateCadence(trigger.cadence);
    } else if (trigger.kind === "pull_request") {
      if (!REPO_PATTERN.test(trigger.repo)) {
        throw new AttackStateError("The repository must be owner/name.");
      }
      if (trigger.events.length === 0) throw new AttackStateError("Pick a pull request event.");
    }
    const roster = [...new Set(input.definition.roster)];
    for (const role of roster) {
      const needs = ATTACK_ROLE_REQUIREMENTS[role];
      if (needs.testCredentials) {
        throw new AttackStateError("Auth needs test credentials, which a saved run does not keep.");
      }
      if (needs.repository && !input.definition.repoScope) {
        throw new AttackStateError("The secrets and config auditor reads the repository.");
      }
      if (needs.disposableTarget && !input.definition.disposableTarget) {
        throw new AttackStateError("The bounded load test needs a disposable target.");
      }
    }
    // A pull-request run is read-only: no writes, no load.
    if (trigger.kind === "pull_request") {
      if (input.definition.disposableTarget) {
        throw new AttackStateError(
          "A pull-request run is read-only: the target is not disposable.",
        );
      }
    }
    const startCommand = input.startCommand?.trim() || null;
    return {
      workspaceId: input.workspaceId,
      name: input.name.trim(),
      enabled: input.enabled,
      trigger:
        trigger.kind === "schedule"
          ? { ...trigger, cadence: withHostTimeZone(trigger.cadence) }
          : trigger,
      definition: { ...input.definition, roster },
      startCommand,
      healthUrl: input.healthUrl,
    };
  }

  // ---- firing ----

  private auditLog(scheduleId: string): SqlAuditLog<AttackScheduleAuditEntry> {
    return new SqlAuditLog(
      this.database,
      `attack_schedule:${scheduleId}`,
      AttackScheduleAuditEntrySchema,
    );
  }

  private record(
    schedule: AttackSchedule,
    outcome: AttackScheduleOutcome,
    runId: string | null,
    detail: string,
  ): AttackScheduleAuditEntry {
    const entry = {
      at: new Date().toISOString(),
      scheduleId: schedule.id,
      outcome,
      runId,
      detail: detail.slice(0, 500),
    };
    this.auditLog(schedule.id).append({
      scheduleId: entry.scheduleId,
      outcome,
      runId,
      detail: entry.detail,
    });
    return entry;
  }

  /** `event` is the pull request that fired it, or null for a cadence or "Run now". */
  private async fire(
    schedule: AttackSchedule,
    event: AutomationPullRequestEvent | null,
  ): Promise<AttackScheduleAuditEntry> {
    if (this.firing.has(schedule.id)) {
      return this.record(schedule, "skipped_busy", null, "A fire of this schedule is in progress.");
    }
    this.firing.add(schedule.id);
    let child: ChildProcess | null = null;
    try {
      const live = (await this.attack.listRuns({ workspaceId: schedule.workspaceId })).find(
        (run) => run.status === "running" || run.status === "paused",
      );
      if (live) {
        return this.record(
          schedule,
          "skipped_busy",
          live.id,
          `The workspace already has a ${live.status} run.`,
        );
      }
      const health = await this.ensureHealthy(schedule);
      child = health.child;
      if (!health.healthy) {
        if (child?.pid) killTree(child.pid);
        if (child) this.startedChildren.delete(child);
        return this.record(
          schedule,
          "skipped_unhealthy",
          null,
          `${schedule.healthUrl} was not healthy within ${SCHEDULE_HEALTH_TIMEOUT_MS / 1000}s` +
            (schedule.startCommand ? " after running the start command." : "."),
        );
      }
      const readOnly = schedule.trigger.kind === "pull_request";
      const definition = schedule.definition;
      const run = await this.attack.startRun({
        workspaceId: schedule.workspaceId,
        cwd: definition.cwd,
        target: definition.target,
        repoScope: definition.repoScope,
        scopeNotes: event
          ? pullRequestScopeNotes(definition.scopeNotes, event)
          : definition.scopeNotes,
        provider: definition.provider,
        roster: definition.roster,
        disposableTarget: readOnly ? false : definition.disposableTarget,
        testCredentials: "",
        limits: definition.limits,
        annotations: [],
        onlyAnnotated: false,
        desktopTarget: null,
        allowDesktopInput: false,
      });
      this.watched.set(run.id, { scheduleId: schedule.id, child });
      child = null;
      await this.schedules.update(schedule.id, (current) => ({
        ...current,
        lastFiredAt: new Date().toISOString(),
      }));
      return this.record(
        schedule,
        "started",
        run.id,
        event ? `Pull request #${event.number}` : "Run started.",
      );
    } catch (error) {
      if (child?.pid) killTree(child.pid);
      if (child) this.startedChildren.delete(child);
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ err: error, scheduleId: schedule.id }, "Scheduled attack run failed");
      return this.record(schedule, "failed", null, message);
    } finally {
      this.firing.delete(schedule.id);
    }
  }

  private async ensureHealthy(
    schedule: AttackSchedule,
  ): Promise<{ healthy: boolean; child: ChildProcess | null }> {
    if (await this.isHealthy(schedule.healthUrl)) return { healthy: true, child: null };
    let child: ChildProcess | null = null;
    if (schedule.startCommand) {
      child = spawnProcess(schedule.startCommand, [], {
        cwd: schedule.definition.cwd,
        shell: true,
        stdio: "ignore",
      });
      this.startedChildren.add(child);
      child.on("error", (error) => {
        this.logger.warn({ err: error, scheduleId: schedule.id }, "Start command failed");
      });
    }
    const deadline = Date.now() + SCHEDULE_HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
      if (await this.isHealthy(schedule.healthUrl)) return { healthy: true, child };
    }
    return { healthy: false, child };
  }

  // ---- ticking ----

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.watchRuns();
      const now = new Date();
      for (const schedule of await this.schedules.list()) {
        if (!schedule.enabled) continue;
        if (schedule.trigger.kind === "schedule") await this.tickCadence(schedule, now);
        else if (schedule.trigger.kind === "pull_request") this.tickPullRequests(schedule, now);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async tickCadence(schedule: AttackSchedule, now: Date): Promise<void> {
    if (schedule.trigger.kind !== "schedule") return;
    if (!schedule.nextFireAt || new Date(schedule.nextFireAt).getTime() > now.getTime()) return;
    // A slot is spent once claimed, even when the fire is then skipped; missed slots while the
    // daemon was down are not caught up.
    const cadence = schedule.trigger.cadence;
    let next = new Date(schedule.nextFireAt);
    while (next.getTime() <= now.getTime()) next = computeNextRunAt(cadence, next);
    await this.schedules.update(schedule.id, (current) => ({
      ...current,
      nextFireAt: next.toISOString(),
    }));
    void this.fire(schedule, null);
  }

  private tickPullRequests(schedule: AttackSchedule, now: Date): void {
    if (schedule.trigger.kind !== "pull_request") return;
    const last = this.lastPollAt.get(schedule.id) ?? 0;
    if (this.polling.has(schedule.id) || now.getTime() - last < PULL_REQUEST_POLL_INTERVAL_MS) {
      return;
    }
    this.lastPollAt.set(schedule.id, now.getTime());
    this.polling.add(schedule.id);
    const trigger = schedule.trigger;
    void (async () => {
      try {
        const result = await pollPullRequests({
          gh: this.gh,
          automationId: schedule.id,
          repo: trigger.repo,
          events: trigger.events,
          previous: await this.triggerStates.get(schedule.id),
        });
        // Saved before any fire: a head is spent once seen, even when its run is then skipped.
        await this.triggerStates.put(result.state);
        for (const event of result.events) await this.fire(schedule, event);
      } catch (error) {
        this.logger.warn({ err: error, scheduleId: schedule.id }, "Pull request poll failed");
      } finally {
        this.polling.delete(schedule.id);
      }
    })();
  }

  /**
   * Ends what an unattended run cannot end by itself. A run paused by its budget or a stall has no
   * owner to resume it and would hold the workspace's one live slot for good, so the scheduler
   * stops it. When a run has ended, its start command's process is stopped and open blockers are
   * reported to the owner.
   */
  private async watchRuns(): Promise<void> {
    for (const [runId, watch] of Array.from(this.watched)) {
      let run: AttackRun;
      try {
        run = await this.attack.getRun(runId);
      } catch {
        this.release(runId, watch);
        continue;
      }
      if (run.status === "paused" && run.pausedReason !== "user") {
        run = await this.attack.cancelRun(runId);
      }
      if (run.status === "running" || run.status === "paused") continue;
      this.release(runId, watch);
      await this.reportBlockers(run, watch.scheduleId);
    }
  }

  private release(runId: string, watch: WatchedRun): void {
    this.watched.delete(runId);
    if (watch.child) {
      if (watch.child.pid) killTree(watch.child.pid);
      this.startedChildren.delete(watch.child);
    }
  }

  private async reportBlockers(run: AttackRun, scheduleId: string): Promise<void> {
    const schedule = await this.schedules.get(scheduleId);
    if (!schedule) return;
    const findings = await this.attack.listFindings(run.id);
    const blockers = findings.filter(
      (finding) => finding.severity === "blocker" && finding.status === "new",
    );
    if (blockers.length === 0) return;
    this.record(schedule, "blockers", run.id, `${blockers.length} open blocker(s)`);
    try {
      await this.notify?.send({
        title: `Attack found ${blockers.length} blocker${blockers.length === 1 ? "" : "s"}`,
        body: `${schedule.name}: ${blockers[0]?.title ?? ""}`.slice(0, 200),
        data: { attackRunId: run.id, workspaceId: run.workspaceId },
      });
    } catch (error) {
      this.logger.warn({ err: error, scheduleId }, "Could not notify the owner of blockers");
    }
  }
}
