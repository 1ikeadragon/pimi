import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Logger } from "pino";
import { getParentAgentIdFromLabels } from "@pimi/protocol/agent-labels";
import type { AgentUsage } from "@pimi/protocol/agent-types";
import {
  attackAllowedHosts,
  attackUrlHost,
  isAttackHostAllowed,
  isLocalAttackHost,
} from "@pimi/protocol/attack/allowlist";
import {
  AttackRoleIdSchema,
  FindingCategorySchema,
  type AttackAuditAction,
  type AttackAuditEntry,
  type AttackPauseReason,
  type AttackRun,
  type AttackRunDefinition,
  type Finding,
  type FindingCategory,
  type FindingEvidence,
  type FindingSeverity,
  type FindingStatus,
} from "@pimi/protocol/attack/types";
import type { SessionOutboundMessage } from "@pimi/protocol/messages";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { sendPromptToAgent } from "../agent/agent-prompt.js";
import type { BoundCreateAgentCommand } from "../agent/create-agent/create.js";
import { cancelAgentRunCommand } from "../agent/lifecycle-command.js";
import { resumeStoppedSubagents } from "../agent/stop-cascade.js";
import { STOPPED_WITH_SUBAGENTS_LABEL } from "@pimi/protocol/agent-labels";
import { leadPrompt, resumePrompt } from "./prompts.js";
import { ATTACK_COORDINATOR_PROFILE_ID, ATTACK_RUN_LABEL } from "./roster.js";
import { findingSignature } from "./signature.js";
import { AttackStore } from "./store.js";

const TICK_INTERVAL_MS = 2000;
const MAX_ANCESTRY_DEPTH = 8;
const MAX_FINDINGS_PER_RUN = 200;
const MAX_EVIDENCE_PER_FINDING = 6;
const MAX_SCREENSHOT_BASE64_CHARS = 900_000;
const MAX_TEXT = 4000;

export class AttackRunNotFoundError extends Error {
  constructor(id: string) {
    super(`Attack run not found: ${id}`);
    this.name = "AttackRunNotFoundError";
  }
}

export class AttackStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttackStateError";
  }
}

export interface AttackServiceOptions {
  paseoHome: string;
  logger: Logger;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  createAgent: BoundCreateAgentCommand;
  /** Pushes a message to every connected client. */
  emit: (message: SessionOutboundMessage) => void;
}

export interface SubmitFindingInput {
  severity: FindingSeverity;
  category: FindingCategory;
  title: string;
  route: string;
  description: string;
  repro: string;
  evidence: FindingEvidence[];
}

function clip(text: string, max = MAX_TEXT): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const SEVERITY_RANK: Record<FindingSeverity, number> = { blocker: 3, major: 2, minor: 1 };

// What a usage report adds to a run's token spend: input, output and cache writes. Cache reads
// are left out; a long agent loop re-reads its context every step and would burn the budget
// without costing real work.
function usageTokens(usage: AgentUsage): number {
  const sum =
    (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheWriteInputTokens ?? 0);
  return Number.isFinite(sum) && sum > 0 ? Math.round(sum) : 0;
}

function withoutScreenshotBytes(finding: Finding): Finding {
  return {
    ...finding,
    evidence: finding.evidence.map((item) =>
      item.kind === "screenshot" ? { ...item, dataBase64: null } : item,
    ),
  };
}

export class AttackService {
  private readonly store: AttackStore;
  private readonly logger: Logger;
  private readonly agentManager: AgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly createAgent: BoundCreateAgentCommand;
  private readonly emit: AttackServiceOptions["emit"];
  private readonly runIdByAgentId = new Map<string, string>();
  // Session-scoped usage reports are cumulative; remember the last total per agent.
  private readonly sessionTokensByAgentId = new Map<string, number>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeAgents: (() => void) | null = null;
  private ticking = false;
  private readonly tokenWrites = new Map<string, Promise<unknown>>();
  private readonly submitChains = new Map<string, Promise<unknown>>();

  constructor(options: AttackServiceOptions) {
    this.logger = options.logger.child({ module: "attack" });
    this.store = new AttackStore({
      dir: join(options.paseoHome, "attack-runs"),
      logger: this.logger,
    });
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.createAgent = options.createAgent;
    this.emit = options.emit;
  }

  async start(): Promise<void> {
    // The agents of a run that was live when the daemon went down are gone: show it as paused.
    for (const run of await this.store.listRuns()) {
      if (run.status === "running") {
        await this.settleSpent(run.id, { status: "paused", pausedReason: "user" });
      }
    }
    this.unsubscribeAgents = this.agentManager.subscribe(
      (event) => {
        if (event.type !== "agent_stream") return;
        const stream = event.event;
        if (stream.type !== "turn_completed" || !stream.usage) return;
        this.recordUsage(event.agentId, stream.usage);
      },
      { replayState: false, includeInternal: true },
    );
    this.tickTimer = setInterval(() => {
      void this.tick().catch((error) => {
        this.logger.error({ err: error }, "Failed to process attack tick");
      });
    }, TICK_INTERVAL_MS);
    this.tickTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.unsubscribeAgents?.();
    this.unsubscribeAgents = null;
  }

  // ---- runs ----

  async startRun(definition: AttackRunDefinition): Promise<AttackRun> {
    const target = this.validateTarget(definition.target);
    const roster = [...new Set(definition.roster.map((role) => AttackRoleIdSchema.parse(role)))];
    if (roster.length === 0) throw new AttackStateError("Pick at least one agent for the roster.");
    const now = new Date().toISOString();
    const run: AttackRun = {
      id: randomUUID().replaceAll("-", ""),
      workspaceId: definition.workspaceId,
      cwd: definition.cwd,
      target: target.url,
      remoteHost: target.remoteHost,
      scopeNotes: clip(definition.scopeNotes),
      roster,
      disposableTarget: definition.disposableTarget,
      limits: definition.limits,
      status: "running",
      pausedReason: null,
      leadAgentId: null,
      spent: { runtimeMs: 0, tokens: 0 },
      resumedAt: now,
      startedAt: now,
      updatedAt: now,
      endedAt: null,
    };
    await this.store.putRun(run);
    await this.audit(run.id, "run_started", null, `roster=${roster.join(",")}`);
    this.publishRun(run);
    try {
      const created = await this.createAgent({
        kind: "mcp",
        provider: definition.provider,
        profile: ATTACK_COORDINATOR_PROFILE_ID,
        title: `Attack · ${target.host}`,
        initialPrompt: leadPrompt(run),
        cwd: run.cwd,
        workspaceId: run.workspaceId,
        labels: { [ATTACK_RUN_LABEL]: run.id },
        promptFailure: "return-error",
        notifyOnFinish: false,
      });
      const leadAgentId = created.snapshot.id;
      this.runIdByAgentId.set(leadAgentId, run.id);
      await this.audit(run.id, "agent_started", leadAgentId, "lead");
      if (created.initialPromptError) throw created.initialPromptError;
      const updated = await this.store.updateRun(run.id, (current) => ({
        ...current,
        leadAgentId,
        updatedAt: new Date().toISOString(),
      }));
      if (!updated) throw new AttackRunNotFoundError(run.id);
      this.publishRun(updated);
      return updated;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.settleSpent(run.id, { status: "stopped" });
      await this.audit(run.id, "run_stopped", null, "lead_failed");
      throw new AttackStateError(`The lead agent did not start: ${message}`);
    }
  }

  async pauseRun(runId: string, reason: AttackPauseReason = "user"): Promise<AttackRun> {
    const run = await this.requireRun(runId);
    if (run.status !== "running") {
      throw new AttackStateError(`Only a running run can be paused; this one is ${run.status}.`);
    }
    const paused = await this.settleSpent(runId, { status: "paused", pausedReason: reason });
    await this.stopAgents(paused);
    await this.audit(runId, reason === "user" ? "run_paused" : "budget_reached", null, reason);
    return paused;
  }

  async resumeRun(runId: string): Promise<AttackRun> {
    const run = await this.requireRun(runId);
    if (run.status !== "paused") {
      throw new AttackStateError(`Only a paused run can be resumed; this one is ${run.status}.`);
    }
    if (
      run.spent.runtimeMs >= run.limits.maxRuntimeMs ||
      run.spent.tokens >= run.limits.maxTokens
    ) {
      throw new AttackStateError("The budget is spent. Start a new run with a larger budget.");
    }
    const now = new Date().toISOString();
    const resumed = await this.updateAndPublish(runId, (current) => ({
      ...current,
      status: "running",
      pausedReason: null,
      resumedAt: now,
      updatedAt: now,
    }));
    await this.audit(runId, "run_resumed", null, null);
    if (resumed.leadAgentId) {
      const deps = {
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        logger: this.logger,
      };
      // The lead gets the state prompt below, not the generic continue prompt.
      await this.agentManager
        .patchLabels(resumed.leadAgentId, { [STOPPED_WITH_SUBAGENTS_LABEL]: null })
        .catch(() => undefined);
      await resumeStoppedSubagents(deps, resumed.leadAgentId).catch((error: unknown) => {
        this.logger.warn({ err: error, runId }, "Some attack subagents did not resume");
      });
      await sendPromptToAgent({
        ...deps,
        agentId: resumed.leadAgentId,
        prompt: resumePrompt(resumed, await this.store.findings(runId).list()),
        unarchive: false,
      });
    }
    return resumed;
  }

  async cancelRun(runId: string): Promise<AttackRun> {
    const run = await this.requireRun(runId);
    if (run.status === "stopped" || run.status === "completed") return run;
    const stopped = await this.settleSpent(runId, { status: "stopped" });
    await this.stopAgents(stopped);
    await this.audit(runId, "run_stopped", null, "user");
    return stopped;
  }

  /** The lead says the roster is done. */
  async completeRun(runId: string, callerAgentId: string): Promise<AttackRun> {
    const run = await this.requireRun(runId);
    if (run.leadAgentId !== callerAgentId) {
      throw new AttackStateError("Only the lead agent can finish the run.");
    }
    if (run.status !== "running") return run;
    const completed = await this.settleSpent(runId, { status: "completed" });
    await this.audit(runId, "run_completed", callerAgentId, null);
    return completed;
  }

  async getRun(runId: string): Promise<AttackRun> {
    return this.liveSpent(await this.requireRun(runId));
  }

  async getRunWithAudit(runId: string): Promise<{ run: AttackRun; audit: AttackAuditEntry[] }> {
    const run = await this.getRun(runId);
    return { run, audit: await this.store.audit(runId).read() };
  }

  async listRuns(input: { workspaceId?: string } = {}): Promise<AttackRun[]> {
    const runs = await this.store.listRuns();
    return runs
      .filter((run) => !input.workspaceId || run.workspaceId === input.workspaceId)
      .map((run) => this.liveSpent(run));
  }

  // ---- findings ----

  async listFindings(runId: string): Promise<Finding[]> {
    await this.requireRun(runId);
    const findings = await this.store.findings(runId).list();
    return findings
      .sort(
        (left, right) =>
          SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity] ||
          left.createdAt.localeCompare(right.createdAt),
      )
      .map(withoutScreenshotBytes);
  }

  async getFinding(runId: string, findingId: string): Promise<Finding> {
    const finding = await this.store.findings(runId).get(findingId);
    if (!finding) throw new AttackStateError(`Finding not found: ${findingId}`);
    return finding;
  }

  async updateFinding(input: {
    runId: string;
    findingId: string;
    status?: FindingStatus;
    fixAgentId?: string;
  }): Promise<Finding> {
    const updated = await this.store.findings(input.runId).update(input.findingId, (current) => ({
      ...current,
      status: input.status ?? current.status,
      fixAgentId: input.fixAgentId ?? current.fixAgentId,
      updatedAt: new Date().toISOString(),
    }));
    if (!updated) throw new AttackStateError(`Finding not found: ${input.findingId}`);
    await this.audit(input.runId, "finding_updated", null, `${updated.id}:${updated.status}`);
    this.publishFinding(updated);
    return withoutScreenshotBytes(updated);
  }

  // Submissions for one run are applied one at a time, so two agents reporting the same
  // problem at once cannot both pass the duplicate check.
  async submitFinding(
    callerAgentId: string,
    input: SubmitFindingInput,
  ): Promise<{ finding: Finding; deduped: boolean }> {
    const run = await this.runForAgent(callerAgentId);
    if (!run) throw new AttackStateError("This agent is not part of an Attack run.");
    const previous = this.submitChains.get(run.id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.applyFinding(run.id, callerAgentId, input));
    this.submitChains.set(run.id, next);
    return next;
  }

  private async applyFinding(
    runId: string,
    callerAgentId: string,
    input: SubmitFindingInput,
  ): Promise<{ finding: Finding; deduped: boolean }> {
    const run = await this.requireRun(runId);
    if (run.status !== "running") {
      throw new AttackStateError(`The run is ${run.status}; findings are not accepted now.`);
    }
    const category = FindingCategorySchema.parse(input.category);
    const signature = findingSignature({ route: input.route, category, title: input.title });
    const findings = this.store.findings(run.id);
    const existing = (await findings.list()).find((finding) => finding.signature === signature);
    const evidence = input.evidence.slice(0, MAX_EVIDENCE_PER_FINDING);
    const now = new Date().toISOString();
    if (existing) {
      const merged = await findings.update(existing.id, (current) => ({
        ...current,
        severity:
          SEVERITY_RANK[input.severity] > SEVERITY_RANK[current.severity]
            ? input.severity
            : current.severity,
        evidence: [...current.evidence, ...evidence].slice(0, MAX_EVIDENCE_PER_FINDING),
        reportCount: current.reportCount + 1,
        updatedAt: now,
      }));
      if (!merged) throw new AttackStateError("The finding disappeared while merging.");
      await this.audit(run.id, "finding_deduped", callerAgentId, merged.id);
      this.publishFinding(merged);
      return { finding: withoutScreenshotBytes(merged), deduped: true };
    }
    if ((await findings.list()).length >= MAX_FINDINGS_PER_RUN) {
      throw new AttackStateError("This run reached its finding limit.");
    }
    const finding: Finding = {
      id: randomUUID().replaceAll("-", ""),
      runId: run.id,
      agentId: callerAgentId,
      severity: input.severity,
      category,
      title: clip(input.title, 200),
      route: clip(input.route, 500),
      description: clip(input.description),
      repro: clip(input.repro),
      evidence,
      signature,
      status: "new",
      reportCount: 1,
      fixAgentId: null,
      createdAt: now,
      updatedAt: now,
    };
    await findings.put(finding);
    await this.audit(run.id, "finding_submitted", callerAgentId, finding.id);
    this.publishFinding(finding);
    return { finding: withoutScreenshotBytes(finding), deduped: false };
  }

  screenshotEvidence(input: {
    caption: string;
    dataBase64: string;
    width: number;
    height: number;
  }): FindingEvidence {
    return {
      kind: "screenshot",
      caption: clip(input.caption, 300),
      width: input.width,
      height: input.height,
      // An oversized capture keeps its caption and size but not its bytes.
      dataBase64: input.dataBase64.length <= MAX_SCREENSHOT_BASE64_CHARS ? input.dataBase64 : null,
    };
  }

  // ---- agents and navigation ----

  /** The run an agent belongs to, found through its own or an ancestor's run label. */
  async runForAgent(agentId: string): Promise<AttackRun | null> {
    const runId = await this.runIdForAgent(agentId);
    return runId ? this.store.getRun(runId) : null;
  }

  private async runIdForAgent(agentId: string): Promise<string | null> {
    const cached = this.runIdByAgentId.get(agentId);
    if (cached) return cached;
    let current: string | null = agentId;
    const chain: string[] = [];
    for (let depth = 0; current && depth < MAX_ANCESTRY_DEPTH; depth += 1) {
      chain.push(current);
      const labels: Record<string, unknown> | null | undefined =
        this.agentManager.getAgent(current)?.labels ??
        (await this.agentStorage.get(current))?.labels;
      const runId = labels?.[ATTACK_RUN_LABEL];
      if (typeof runId === "string" && runId) {
        for (const id of chain) this.runIdByAgentId.set(id, runId);
        return runId;
      }
      current = getParentAgentIdFromLabels(labels);
    }
    return null;
  }

  /** What the browser tools hand the desktop app for an attack agent; null for any other agent. */
  async guardForAgent(
    agentId: string | undefined,
  ): Promise<{ runId: string; allowedHosts: string[] } | null> {
    if (!agentId) return null;
    const run = await this.runForAgent(agentId);
    return run ? { runId: run.id, allowedHosts: attackAllowedHosts(run.remoteHost) } : null;
  }

  /** Decides a navigation an attack agent asked for; a refusal is audited. */
  async checkNavigation(
    agentId: string | undefined,
    url: string,
  ): Promise<{ allowed: true } | { allowed: false; message: string }> {
    const guard = await this.guardForAgent(agentId);
    if (!guard) return { allowed: true };
    const host = attackUrlHost(url);
    if (isAttackHostAllowed(host, guard.allowedHosts)) return { allowed: true };
    await this.audit(guard.runId, "navigation_refused", agentId ?? null, host ?? "invalid_url");
    return {
      allowed: false,
      message: `This Attack run may only open ${guard.allowedHosts.join(", ")}. Navigation to ${host ?? "that URL"} was refused and recorded.`,
    };
  }

  async recordNavigationRefused(input: {
    runId: string;
    agentId?: string;
    host: string;
  }): Promise<void> {
    await this.requireRun(input.runId);
    await this.audit(input.runId, "navigation_refused", input.agentId ?? null, input.host);
  }

  // ---- internals ----

  private validateTarget(raw: string): { url: string; host: string; remoteHost: string | null } {
    const host = attackUrlHost(raw.trim());
    if (!host) throw new AttackStateError("The target must be an http or https URL.");
    return {
      url: new URL(raw.trim()).toString(),
      host,
      remoteHost: isLocalAttackHost(host) ? null : host,
    };
  }

  private async requireRun(runId: string): Promise<AttackRun> {
    const run = await this.store.getRun(runId);
    if (!run) throw new AttackRunNotFoundError(runId);
    return run;
  }

  private liveSpent(run: AttackRun): AttackRun {
    if (run.status !== "running" || !run.resumedAt) return run;
    const elapsed = Math.max(0, Date.now() - new Date(run.resumedAt).getTime());
    return { ...run, spent: { ...run.spent, runtimeMs: run.spent.runtimeMs + elapsed } };
  }

  // Folds the running stretch into `spent` and applies a status change in one write.
  private async settleSpent(
    runId: string,
    change: { status: AttackRun["status"]; pausedReason?: AttackPauseReason },
  ): Promise<AttackRun> {
    const now = new Date();
    return this.updateAndPublish(runId, (current) => {
      const settled = this.liveSpent(current);
      const ended = change.status === "stopped" || change.status === "completed";
      return {
        ...current,
        status: change.status,
        pausedReason: change.status === "paused" ? (change.pausedReason ?? "user") : null,
        spent: settled.spent,
        resumedAt: null,
        updatedAt: now.toISOString(),
        endedAt: ended ? now.toISOString() : current.endedAt,
      };
    });
  }

  private async updateAndPublish(
    runId: string,
    updater: (current: AttackRun) => AttackRun,
  ): Promise<AttackRun> {
    const updated = await this.store.updateRun(runId, updater);
    if (!updated) throw new AttackRunNotFoundError(runId);
    this.publishRun(updated);
    return updated;
  }

  // Stop cascades from the lead through stop-cascade to every subagent below it.
  private async stopAgents(run: AttackRun): Promise<void> {
    if (!run.leadAgentId) return;
    if (!this.agentManager.getAgent(run.leadAgentId)) return;
    try {
      await cancelAgentRunCommand(
        {
          agentManager: this.agentManager,
          agentStorage: this.agentStorage,
          logger: this.logger,
        },
        run.leadAgentId,
      );
    } catch (error) {
      this.logger.warn({ err: error, runId: run.id }, "Stopping the attack lead failed");
    }
  }

  private recordUsage(agentId: string, usage: AgentUsage): void {
    void (async () => {
      const runId = await this.runIdForAgent(agentId);
      if (!runId) return;
      let added = usageTokens(usage);
      if (usage.reportScope === "session") {
        const previous = this.sessionTokensByAgentId.get(agentId) ?? 0;
        this.sessionTokensByAgentId.set(agentId, added);
        added = Math.max(0, added - previous);
      }
      if (added === 0) return;
      const previousWrite = this.tokenWrites.get(runId) ?? Promise.resolve();
      const write = previousWrite.catch(() => undefined).then(() => this.addTokens(runId, added));
      this.tokenWrites.set(runId, write);
      await write;
    })().catch((error: unknown) => {
      this.logger.warn({ err: error, agentId }, "Failed to record attack token usage");
    });
  }

  private async addTokens(runId: string, added: number): Promise<void> {
    const updated = await this.store.updateRun(runId, (current) => ({
      ...current,
      spent: { ...current.spent, tokens: current.spent.tokens + added },
      updatedAt: new Date().toISOString(),
    }));
    if (!updated) return;
    this.publishRun(this.liveSpent(updated));
    if (updated.status === "running" && updated.spent.tokens >= updated.limits.maxTokens) {
      await this.pauseRun(runId, "token_budget");
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const run of await this.store.listRuns()) {
        if (run.status !== "running") continue;
        const live = this.liveSpent(run);
        if (live.spent.runtimeMs >= run.limits.maxRuntimeMs) {
          await this.pauseRun(run.id, "time_budget");
        } else {
          this.publishRun(live);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private audit(
    runId: string,
    action: AttackAuditAction,
    agentId: string | null,
    detail: string | null,
  ): Promise<void> {
    return this.store.audit(runId).append({ runId, action, agentId, detail });
  }

  private publishRun(run: AttackRun): void {
    this.emit({ type: "attack.run.changed", payload: { run } });
  }

  private publishFinding(finding: Finding): void {
    this.emit({
      type: "attack.finding.changed",
      payload: { finding: withoutScreenshotBytes(finding) },
    });
  }
}
