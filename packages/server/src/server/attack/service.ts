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
  type AttackCoverage,
  type AttackDesktopAction,
  type AttackCoverageRoute,
  type AttackLimits,
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
import type { AgentSessionConfig } from "../agent/agent-sdk-types.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { sendPromptToAgent } from "../agent/agent-prompt.js";
import type { BoundCreateAgentCommand } from "../agent/create-agent/create.js";
import { cancelAgentRunCommand } from "../agent/lifecycle-command.js";
import { resumeStoppedSubagents } from "../agent/stop-cascade.js";
import { ATTACK_RUN_LABEL, STOPPED_WITH_SUBAGENTS_LABEL } from "@pimi/protocol/agent-labels";
import { AttackCoverageTracker } from "./coverage.js";
import {
  clipResultNote,
  findAnnotation,
  persistAnnotations,
  readAnnotationImage,
  resolveAnnotationLabels,
} from "./annotations.js";
import { leadPrompt, resumePrompt, stallPrompt } from "./prompts.js";
import { ATTACK_COORDINATOR_PROFILE_ID } from "./roster.js";
import { findingSignature } from "./signature.js";
import { AttackStore } from "./store.js";

const TICK_INTERVAL_MS = 2000;
const MAX_ANCESTRY_DEPTH = 8;
const MAX_FINDINGS_PER_RUN = 200;
const MAX_EVIDENCE_PER_FINDING = 6;
const MAX_SCREENSHOT_BASE64_CHARS = 900_000;
const MAX_TEXT = 4000;
// A running run whose agents are all idle is nudged after this long, and paused as "stalled"
// once it has been nudged this many times without an agent starting work.
const STALL_GRACE_MS = 30_000;
const MAX_STALL_NUDGES = 2;

export class AttackRunNotFoundError extends Error {
  constructor(id: string) {
const MAX_SPEND_AGENTS = 16;
// A usage report arrives after every turn; clients hear about the run at most this often.
const RUN_PUSH_INTERVAL_MS = 1000;
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
  pimiHome: string;
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
  /** The id of an existing finding this report repeats; its evidence is merged into that one. */
  duplicateOf?: string;
  /** The caller read the run's existing findings and says this is none of them. */
  distinct?: boolean;
  /** Labels ("A1") of the owner's pre-flight annotations this finding tests. */
  annotationLabels?: string[];
}

/**
 * `review` means nothing was recorded: the caller has not yet compared its report with the
 * findings listed, and submits again with `duplicateOf` or `distinct`.
 */
export type SubmitFindingResult =
  | { outcome: "recorded" | "merged"; finding: Finding }
  | { outcome: "review"; existing: Finding[] };

export interface FindingMerge {
  duplicate: string;
  into: string;
}

/**
 * Claude loads MCP servers from the user's settings, plugins and claude.ai connectors. A global
 * browser server (such as a Playwright plugin) would give an attack agent a browser path that skips
 * the host allowlist, so an attack agent keeps only the MCP servers Pimi passes it. It also loses
 * Claude's own web tools, which reach any host, and its file-editing tools, since a run only
 * reads. The shell stays: it is how the agents read the repository, and it is not sandboxed.
 * Subagents the lead creates inherit these provider options from it (create_agent, same provider).
 */
function attackProviderConfig(provider: string): Partial<AgentSessionConfig> {
  // `provider` is "provider" or "provider/model".
  if (provider.split("/")[0] !== "claude") return {};
  return {
    providerOptions: {
      extraArgs: { "strict-mcp-config": null },
      disallowedTools: ["WebFetch", "WebSearch", "Edit", "Write", "NotebookEdit"],
    },
  };
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
  // When a running run's agents all went idle, and how often its lead has been nudged since.
  private readonly stalls = new Map<string, { since: number; nudges: number }>();
  private readonly tokenWrites = new Map<string, Promise<unknown>>();
  private readonly submitChains = new Map<string, Promise<unknown>>();
  // The findings each agent has been shown by submit_finding. A new finding is recorded only once
  // its reporter has seen every finding the run already holds. Lost on restart: agents look again.
  private readonly shownFindingIdsByAgentId = new Map<string, Set<string>>();

  constructor(options: AttackServiceOptions) {
    this.logger = options.logger.child({ module: "attack" });
    this.store = new AttackStore({
      dir: join(options.pimiHome, "attack-runs"),
      logger: this.logger,
    });
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
  private readonly coverage: AttackCoverageTracker;
  // Token reports coalesce: the newest run waits here for the next push slot.
  private readonly runPushes = new Map<
    string,
    { lastAt: number; timer: ReturnType<typeof setTimeout> | null; run: AttackRun | null }
  >();
    this.createAgent = options.createAgent;
    this.emit = options.emit;
  }

  async start(): Promise<void> {
    // The agents of a run that was live when the daemon went down are gone: show it as paused.
    // Its running stretch ends at the last write, so the time the daemon was down is not spent.
    for (const run of await this.store.listRuns()) {
      if (run.status === "running") {
        await this.settleSpent(
          run.id,
    this.coverage = new AttackCoverageTracker({
      dir: join(options.pimiHome, "attack-runs"),
      logger: this.logger,
      emit: options.emit,
    });
          { status: "paused", pausedReason: "user" },
          new Date(run.updatedAt),
        );
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
    const target = this.validateTarget(definition.target, definition.desktopTarget);
    const roster = [...new Set(definition.roster.map((role) => AttackRoleIdSchema.parse(role)))];
    if (roster.length === 0) throw new AttackStateError("Pick at least one agent for the roster.");
    if (!definition.repoScope && roster.includes("secrets-audit")) {
    for (const push of this.runPushes.values()) if (push.timer) clearTimeout(push.timer);
    this.runPushes.clear();
    await this.coverage.stop();
      throw new AttackStateError("The secrets and config auditor reads the repository.");
    }
    const live = (await this.store.listRuns()).find(
      (existing) =>
        existing.workspaceId === definition.workspaceId &&
        (existing.status === "running" || existing.status === "paused"),
    );
    if (live) {
      throw new AttackStateError(`This workspace already has a ${live.status} run. Stop it first.`);
    }
    const now = new Date().toISOString();
    const runId = randomUUID().replaceAll("-", "");
    const annotations = await persistAnnotations(
      this.store.dir,
      runId,
      definition.annotations,
      clip,
    );
    const run: AttackRun = {
      id: runId,
      workspaceId: definition.workspaceId,
      cwd: definition.cwd,
      target: target.url,
      remoteHost: target.remoteHost,
      repoScope: definition.repoScope,
      scopeNotes: clip(definition.scopeNotes),
      provider: definition.provider,
      roster,
      disposableTarget: definition.disposableTarget,
      limits: definition.limits,
      annotations,
      onlyAnnotated: definition.onlyAnnotated && annotations.length > 0,
      desktopTarget: definition.desktopTarget,
      allowDesktopInput: definition.allowDesktopInput,
      annotationResults: {},
      spentByAgent: {},
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
        config: attackProviderConfig(definition.provider),
        // The provider's own unattended mode, as for an automation step. Nobody answers permission
        // prompts during a run; subagents the lead creates inherit it from their unattended parent.
        // The run is read-only by its host allowlist, instructions, budget and audit log.
        unattended: true,
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
    await this.audit(
      runId,
      reason === "user" || reason === "stalled" ? "run_paused" : "budget_reached",
      null,
      reason,
    );
    return paused;
  }

  async resumeRun(runId: string, newLimits?: AttackLimits): Promise<AttackRun> {
    const run = await this.requireRun(runId);
    if (run.status !== "paused") {
      throw new AttackStateError(`Only a paused run can be resumed; this one is ${run.status}.`);
    }
    const limits = newLimits ?? run.limits;
    if (newLimits) {
      if (
        newLimits.maxRuntimeMs < run.limits.maxRuntimeMs ||
        newLimits.maxTokens < run.limits.maxTokens
      ) {
        throw new AttackStateError("New limits can only raise the budget, not lower it.");
      }
    }
    if (run.spent.runtimeMs >= limits.maxRuntimeMs || run.spent.tokens >= limits.maxTokens) {
      throw new AttackStateError(
        newLimits
          ? "Both new limits must be above what the run has already spent."
          : "The budget is spent. Add budget to resume, or start a new run.",
      );
    }
    const now = new Date().toISOString();
    const resumed = await this.updateAndPublish(runId, (current) => ({
      ...current,
      limits,
      status: "running",
      pausedReason: null,
      resumedAt: now,
      updatedAt: now,
    }));
    if (newLimits) {
      await this.audit(
        runId,
        "budget_extended",
        null,
        `${Math.round(limits.maxRuntimeMs / 60_000)}min,${limits.maxTokens}tok`,
      );
    }
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
      try {
        await sendPromptToAgent({
          ...deps,
          agentId: resumed.leadAgentId,
          prompt: resumePrompt(resumed, await this.openFindings(runId)),
          unarchive: false,
        });
      } catch (error) {
        // Nobody is working: a run left "running" would only burn its time budget.
        await this.settleSpent(runId, { status: "paused", pausedReason: "user" });
        const message = error instanceof Error ? error.message : String(error);
        throw new AttackStateError(`The lead agent did not resume: ${message}`);
      }
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

  /**
   * The lead says the roster is done. With two or more findings and no `merges`, nothing ends:
   * `review` hands the lead the findings to check for duplicates, and it calls again with the
   * pairs to merge (or none).
   */
  async completeRun(
    runId: string,
    callerAgentId: string,
    merges?: readonly FindingMerge[],
  ): Promise<{ run: AttackRun; review: Finding[] | null }> {
    const run = await this.requireRun(runId);
    if (run.leadAgentId !== callerAgentId) {
      throw new AttackStateError("Only the lead agent can finish the run.");
    }
    if (run.status !== "running") return { run, review: null };
    if (!merges) {
      const open = await this.openFindings(runId);
      if (open.length >= 2) return { run, review: open.map(withoutScreenshotBytes) };
    }
    if (merges?.length) {
      await this.inSubmitChain(runId, () => this.applyMerges(runId, callerAgentId, merges));
    }
    const completed = await this.settleSpent(runId, { status: "completed" });
    await this.audit(runId, "run_completed", callerAgentId, null);
    await this.stopSubagents(completed);
    return { run: completed, review: null };
  }

  /** The stored run. `spent.runtimeMs` is settled time only; a client adds the stretch since `resumedAt`. */
  async getRun(runId: string): Promise<AttackRun> {
    return this.requireRun(runId);
  }

  async getRunWithAudit(runId: string): Promise<{ run: AttackRun; audit: AttackAuditEntry[] }> {
    const run = await this.getRun(runId);
    return { run, audit: await this.store.audit(runId).read() };
  }

  async listRuns(input: { workspaceId?: string } = {}): Promise<AttackRun[]> {
    const runs = await this.store.listRuns();
    return runs.filter((run) => !input.workspaceId || run.workspaceId === input.workspaceId);
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
  ): Promise<SubmitFindingResult> {
    const run = await this.runForAgent(callerAgentId);
    if (!run) throw new AttackStateError("This agent is not part of an Attack run.");
    return this.inSubmitChain(run.id, () => this.applyFinding(run.id, callerAgentId, input));
  }

  private inSubmitChain<R>(runId: string, work: () => Promise<R>): Promise<R> {
    const previous = this.submitChains.get(runId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.submitChains.set(runId, next);
    return next;
  }

  /** The run's findings that were not merged into another one, oldest first. */
  private async openFindings(runId: string): Promise<Finding[]> {
    const findings = await this.store.findings(runId).list();
    return findings
      .filter((finding) => finding.duplicateOf === null)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  // Whether two reports describe one defect is a judgement about meaning, so the reporting agent
  // makes it: it is shown the run's findings and answers `duplicateOf` or `distinct`. Only a
  // report with the same route, category and title as an existing one is merged without asking.
  private async applyFinding(
    runId: string,
    callerAgentId: string,
    input: SubmitFindingInput,
  ): Promise<SubmitFindingResult> {
    const run = await this.requireRun(runId);
    if (run.status !== "running") {
      throw new AttackStateError(`The run is ${run.status}; findings are not accepted now.`);
    }
    const category = FindingCategorySchema.parse(input.category);
    const signature = findingSignature({ route: input.route, category, title: input.title });
    const findings = this.store.findings(run.id);
    const all = await findings.list();
    const open = await this.openFindings(run.id);
    const evidence = input.evidence.slice(0, MAX_EVIDENCE_PER_FINDING);
    let annotationLabels: string[];
    try {
      annotationLabels = resolveAnnotationLabels(run.annotations, input.annotationLabels ?? []);
    } catch (error) {
      throw new AttackStateError(error instanceof Error ? error.message : String(error));
    }

    const named = input.duplicateOf ? this.mergeTarget(all, input.duplicateOf) : null;
    const repeated = named ?? open.find((finding) => finding.signature === signature);
    if (repeated) {
      const merged = await this.foldReport(run.id, repeated.id, {
        severity: input.severity,
        evidence,
        reportCount: 1,
        annotationLabels,
      });
      await this.audit(run.id, "finding_deduped", callerAgentId, merged.id);
      return { outcome: "merged", finding: withoutScreenshotBytes(merged) };
    }

    const shown = this.shownFindingIdsByAgentId.get(callerAgentId) ?? new Set<string>();
    this.shownFindingIdsByAgentId.set(callerAgentId, shown);
    const unseen = open.some((finding) => !shown.has(finding.id));
    if (open.length > 0 && (!input.distinct || unseen)) {
      for (const finding of open) shown.add(finding.id);
      return { outcome: "review", existing: open.map(withoutScreenshotBytes) };
    }

    if (all.length >= MAX_FINDINGS_PER_RUN) {
      throw new AttackStateError("This run reached its finding limit.");
    }
    const now = new Date().toISOString();
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
      annotationLabels,
      signature,
      status: "new",
      reportCount: 1,
      duplicateOf: null,
      fixAgentId: null,
      createdAt: now,
      updatedAt: now,
    };
    await findings.put(finding);
    shown.add(finding.id);
    await this.audit(run.id, "finding_submitted", callerAgentId, finding.id);
    this.publishFinding(finding);
    return { outcome: "recorded", finding: withoutScreenshotBytes(finding) };
  }

  // The finding a report or a merge lands on: the one named, or the one it was merged into.
  private mergeTarget(all: readonly Finding[], id: string): Finding {
    const byId = new Map(all.map((finding) => [finding.id, finding]));
    let target = byId.get(id.trim());
    for (let hops = 0; target?.duplicateOf && hops < all.length; hops += 1) {
      target = byId.get(target.duplicateOf);
    }
    if (!target) {
      throw new AttackStateError(
        `This run has no finding ${id}. Use an id from the list submit_finding returned.`,
      );
    }
    return target;
  }

  // Adds a repeated report to the finding it repeats: worst severity, more evidence, a higher count.
  private async foldReport(
    runId: string,
    findingId: string,
    report: {
      severity: FindingSeverity;
      evidence: FindingEvidence[];
      reportCount: number;
      annotationLabels: readonly string[];
    },
  ): Promise<Finding> {
    const merged = await this.store.findings(runId).update(findingId, (current) => ({
      ...current,
      severity:
        SEVERITY_RANK[report.severity] > SEVERITY_RANK[current.severity]
          ? report.severity
          : current.severity,
      evidence: [...current.evidence, ...report.evidence].slice(0, MAX_EVIDENCE_PER_FINDING),
      reportCount: current.reportCount + report.reportCount,
      annotationLabels: [...new Set([...current.annotationLabels, ...report.annotationLabels])],
      updatedAt: new Date().toISOString(),
    }));
    if (!merged) throw new AttackStateError("The finding disappeared while merging.");
    this.publishFinding(merged);
    return merged;
  }

  // The lead's duplicate review: each `duplicate` is folded into `into` and hidden behind it.
  private async applyMerges(
    runId: string,
    callerAgentId: string | null,
    merges: readonly FindingMerge[],
  ): Promise<void> {
    const findings = this.store.findings(runId);
    for (const merge of merges) {
      const all = await findings.list();
      const duplicate = this.mergeTarget(all, merge.duplicate);
      const into = this.mergeTarget(all, merge.into);
      // Already one finding, for example after an earlier pair in the same call.
      if (duplicate.id === into.id) continue;
      await this.foldReport(runId, into.id, duplicate);
      const hidden = await findings.update(duplicate.id, (current) => ({
        ...current,
        duplicateOf: into.id,
        updatedAt: new Date().toISOString(),
      }));
      if (hidden) this.publishFinding(hidden);
      await this.audit(runId, "finding_deduped", callerAgentId, `${duplicate.id}>${into.id}`);
    }
  }

  /** Null when the image is over the size cap; the caller retries narrower or records a note. */
  screenshotEvidence(input: {
    caption: string;
    dataBase64: string;
    width: number;
    height: number;
  }): FindingEvidence | null {
    if (input.dataBase64.length > MAX_SCREENSHOT_BASE64_CHARS) return null;
    return {
      kind: "screenshot",
      caption: clip(input.caption, 300),
      width: input.width,
      height: input.height,
      dataBase64: input.dataBase64,
    };
  }

  // ---- annotations ----

  /** An annotation's text for an agent of the run, with its screenshot when the owner's element had one. */
  async annotationForAgent(
    callerAgentId: string,
    label: string,
  ): Promise<{ annotation: AttackRun["annotations"][number]; imageBase64: string | null }> {
    const run = await this.runForAgent(callerAgentId);
    if (!run) throw new AttackStateError("This agent is not part of an Attack run.");
    const annotation = findAnnotation(run.annotations, label);
    if (!annotation) {
      const known = run.annotations.map((item) => item.label).join(", ") || "none";
      throw new AttackStateError(`This run has no annotation ${label}. Its annotations: ${known}.`);
    }
    return {
      annotation,
      imageBase64: await readAnnotationImage(this.store.dir, run.id, annotation),
    };
  }

  /** The lead's verdict on an annotation no finding covers: it held, or it could not be tested. */
  async reportAnnotationResult(
    callerAgentId: string,
    input: { label: string; result: "clean" | "not_testable"; note: string },
  ): Promise<AttackRun> {
    const run = await this.runForAgent(callerAgentId);
    if (!run) throw new AttackStateError("This agent is not part of an Attack run.");
    if (run.status !== "running") {
      throw new AttackStateError(`The run is ${run.status}; results are not accepted now.`);
    }
    const annotation = findAnnotation(run.annotations, input.label);
    if (!annotation) {
      const known = run.annotations.map((item) => item.label).join(", ") || "none";
      throw new AttackStateError(
        `This run has no annotation ${input.label}. Its annotations: ${known}.`,
      );
    }
    const updated = await this.updateAndPublish(run.id, (current) => ({
      ...current,
      annotationResults: {
        ...current.annotationResults,
        [annotation.label]: clipResultNote({ result: input.result, note: input.note }),
      },
      updatedAt: new Date().toISOString(),
    }));
    return updated;
  }

  // ---- agents and navigation ----

  /** The run an agent belongs to, found through its own or an ancestor's run label. */
  async runForAgent(agentId: string): Promise<AttackRun | null> {
    const runId = await this.runIdForAgent(agentId);
    return runId ? this.store.getRun(runId) : null;
  }

  async runIdForAgent(agentId: string): Promise<string | null> {
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

  // ---- desktop target ----

  /**
   * What `desktop_*` tools hand the desktop app for an agent of a run with a desktop target; null
   * for any other agent. The guard is the only thing that names the window, and it comes from the
   * run record, never from tool input.
   */
  async desktopGuardForAgent(agentId: string | undefined): Promise<{
    runId: string;
    status: AttackRun["status"];
    guard: { runId: string; bundleId: string; windowTitle: string; allowInput: boolean };
  } | null> {
    if (!agentId) return null;
    const run = await this.runForAgent(agentId);
    if (!run?.desktopTarget) return null;
    return {
      runId: run.id,
      status: run.status,
      guard: {
        runId: run.id,
        bundleId: run.desktopTarget.bundleId,
        windowTitle: run.desktopTarget.windowTitle,
        allowInput: run.allowDesktopInput || run.disposableTarget,
      },
    };
  }

  /** Audits a desktop action (verb and element role, never typed text) and tells the owner's log. */
  async recordDesktopAction(input: {
    runId: string;
    agentId: string;
    verb: AttackDesktopAction["verb"];
    outcome:
      | {
          ok: { role: string | null; label: string | null; point: { x: number; y: number } | null };
        }
      | { refused: string };
  }): Promise<void> {
    if ("refused" in input.outcome) {
      await this.audit(
        input.runId,
        "desktop_action",
        input.agentId,
        clip(input.outcome.refused, 200),
      );
      return;
    }
    const { role, label, point } = input.outcome.ok;
    await this.audit(
      input.runId,
      "desktop_action",
      input.agentId,
      role ? `${input.verb} ${role}` : input.verb,
    );
    this.emit({
      type: "attack.desktop.action",
      payload: {
        action: {
          runId: input.runId,
          agentId: input.agentId,
          verb: input.verb,
          role,
          label: label ? clip(label, 200) : null,
          point,
          at: new Date().toISOString(),
        },
      },
    });
  }

  // ---- internals ----

  private validateTarget(
    raw: string,
    desktopTarget: AttackRunDefinition["desktopTarget"],
  ): { url: string; host: string; remoteHost: string | null } {
    // A run drives a URL, a desktop window, or both. Without a URL, the browser allowlist is
    // localhost only and the run is labelled with the app.
    if (!raw.trim() && desktopTarget) {
      return { url: "", host: desktopTarget.appName, remoteHost: null };
    }
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

  private liveSpent(run: AttackRun, until = new Date()): AttackRun {
    if (run.status !== "running" || !run.resumedAt) return run;
    const elapsed = Math.max(0, until.getTime() - new Date(run.resumedAt).getTime());
    return { ...run, spent: { ...run.spent, runtimeMs: run.spent.runtimeMs + elapsed } };
  }

  // Folds the running stretch into `spent` and applies a status change in one write.
  private async settleSpent(
    runId: string,
    change: { status: AttackRun["status"]; pausedReason?: AttackPauseReason },
    stretchEnd?: Date,
  ): Promise<AttackRun> {
    const now = new Date();
    return this.updateAndPublish(runId, (current) => {
      const settled = this.liveSpent(current, stretchEnd ?? now);
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
  // ---- coverage ----

  /** A route an agent's browser tab reached; only agents of this run count. */
  async recordCoverage(input: {
    runId: string;
    agentId: string;
    route: string;
  }): Promise<AttackCoverageRoute> {
    await this.requireRun(input.runId);
    if ((await this.runIdForAgent(input.agentId)) !== input.runId) {
      throw new AttackStateError("That agent is not part of this Attack run.");
    }
    return this.coverage.record(input.runId, input.agentId, input.route);
  }

  async getCoverage(runId: string): Promise<AttackCoverage> {
    await this.requireRun(runId);
    return this.coverage.get(runId);
  }

  /** The owner folds one finding into another; the duplicate is hidden behind it. Works on finished runs. */
  async mergeFindings(input: {
    runId: string;
    duplicateId: string;
    intoId: string;
  }): Promise<Finding> {
    await this.requireRun(input.runId);
    return this.inSubmitChain(input.runId, async () => {
      await this.applyMerges(input.runId, null, [
        { duplicate: input.duplicateId, into: input.intoId },
      ]);
      const all = await this.store.findings(input.runId).list();
      return withoutScreenshotBytes(this.mergeTarget(all, input.intoId));
    });
  }

    } catch (error) {
      this.logger.warn({ err: error, runId: run.id }, "Stopping the attack lead failed");
    }
  }

  // A finished run needs no more work: subagents still going would only spend tokens. The lead is
  // left alone so it can write its closing message.
  private async stopSubagents(run: AttackRun): Promise<void> {
    for (const agent of this.agentManager.listAgents()) {
      if (agent.id === run.leadAgentId || !this.agentManager.hasInFlightRun(agent.id)) continue;
      if ((await this.runIdForAgent(agent.id)) !== run.id) continue;
      await this.agentManager.cancelAgentRun(agent.id).catch((error: unknown) => {
        this.logger.warn({ err: error, runId: run.id, agentId: agent.id }, "Subagent stop failed");
      });
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
      const write = previousWrite
        .catch(() => undefined)
        .then(() => this.addTokens(runId, agentId, added));
      this.tokenWrites.set(runId, write);
      await write;
    })().catch((error: unknown) => {
      this.logger.warn({ err: error, agentId }, "Failed to record attack token usage");
    });
  }

  private async addTokens(runId: string, agentId: string, added: number): Promise<void> {
    const updated = await this.store.updateRun(runId, (current) => ({
      ...current,
      spent: { ...current.spent, tokens: current.spent.tokens + added },
      updatedAt: new Date().toISOString(),
    }));
    if (!updated) return;
    this.publishRunCoalesced(updated);
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
        // Clients count the open stretch themselves from `resumedAt`; publishing live time here
        // would be counted twice.
        if (live.spent.runtimeMs >= run.limits.maxRuntimeMs) {
          await this.pauseRun(run.id, "time_budget");
          continue;
        }
        await this.watchForStall(run);
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Whether the lead or any agent below it has a turn in flight or is waiting for the owner to
   * answer a permission prompt. A pending prompt is the owner's move, not a stall: nudging the
   * agent or pausing the run as "stalled" would be wrong.
   */
  private async runHasWork(run: AttackRun): Promise<boolean> {
    for (const agent of this.agentManager.listAgents({ includeInternal: true })) {
      if (!this.agentManager.hasInFlightRun(agent.id) && agent.pendingPermissions.size === 0) {
        continue;
      }
      if (agent.id === run.leadAgentId || (await this.runIdForAgent(agent.id)) === run.id) {
        return true;
      }
    }
    return false;
  }

  // A run is "running" only while somebody works. When the lead ends its turn without starting
  // subagents or finishing, nothing would ever wake it: nudge it, and pause the run for the
  // owner when the nudges do not start any work.
  private async watchForStall(run: AttackRun): Promise<void> {
    if (!run.leadAgentId) return;
    if (await this.runHasWork(run)) {
      this.stalls.delete(run.id);
      return;
    }
    const now = Date.now();
    const stall = this.stalls.get(run.id) ?? { since: now, nudges: 0 };
    this.stalls.set(run.id, stall);
    if (now - stall.since < STALL_GRACE_MS) return;
    if (stall.nudges >= MAX_STALL_NUDGES) {
      this.stalls.delete(run.id);
      await this.pauseRun(run.id, "stalled");
      return;
    }
    stall.since = now;
    stall.nudges += 1;
    this.logger.warn({ runId: run.id, nudges: stall.nudges }, "Attack run stalled; nudging lead");
    try {
      await sendPromptToAgent({
      // At most 16 agents are broken out; the rest only count toward the total.
      spentByAgent:
        agentId in current.spentByAgent ||
        Object.keys(current.spentByAgent).length < MAX_SPEND_AGENTS
          ? { ...current.spentByAgent, [agentId]: (current.spentByAgent[agentId] ?? 0) + added }
          : current.spentByAgent,
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        logger: this.logger,
        agentId: run.leadAgentId,
        prompt: stallPrompt(run, await this.openFindings(run.id)),
        unarchive: false,
      });
    } catch (error) {
      this.logger.warn({ err: error, runId: run.id }, "Could not nudge the stalled attack lead");
      stall.nudges = MAX_STALL_NUDGES;
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
    const push = this.runPushes.get(run.id);
    if (push?.timer) clearTimeout(push.timer);
    this.runPushes.set(run.id, { lastAt: Date.now(), timer: null, run: null });
  // Token reports: the first goes out at once, later ones within a second ride one trailing push.
  private publishRunCoalesced(run: AttackRun): void {
    const push = this.runPushes.get(run.id);
    const wait = push ? push.lastAt + RUN_PUSH_INTERVAL_MS - Date.now() : 0;
    if (wait <= 0 && !push?.timer) {
      this.publishRun(run);
      return;
    }
    if (push?.timer) {
      push.run = run;
      return;
    }
    const entry = {
      lastAt: push?.lastAt ?? 0,
      timer: null as ReturnType<typeof setTimeout> | null,
      run,
    };
    entry.timer = setTimeout(() => {
      const latest = entry.run;
      if (latest) this.publishRun(latest);
    }, wait);
    entry.timer.unref?.();
    this.runPushes.set(run.id, entry);
  }

