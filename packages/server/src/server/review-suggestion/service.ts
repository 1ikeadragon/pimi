import type { Logger } from "pino";
import { isPimiReviewSuggestionTool } from "@pimi/protocol/pimi-task";
import { resolvePimiToolLeaf } from "@pimi/protocol/pimi-tool-presentation/index";
import { SETTLE_MS, isUserChat } from "../action-items/service.js";
import type { AgentManager, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStreamEvent } from "../agent/agent-sdk-types.js";
import type { WorkspaceGitRuntimeSnapshot, WorkspaceGitService } from "../workspace-git-service.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";

const SUGGESTION_MESSAGE = "Changes ready to review";

export interface ReviewSuggestionServiceOptions {
  logger: Logger;
  agentManager: AgentManager;
  workspaceRegistry: Pick<WorkspaceRegistry, "get">;
  workspaceGitService: Pick<WorkspaceGitService, "getSnapshot">;
}

interface TurnState {
  /** Bumped by every turn start, so work scheduled for an earlier turn can tell it is stale. */
  generation: number;
  /** The checkout's fingerprint when the turn began; null when it could not be read. */
  start: Promise<string | null>;
  /** The agent called suggest_pimi_review itself during this turn. */
  suggestedByAgent: boolean;
}

function fingerprintOf(git: WorkspaceGitRuntimeSnapshot["git"]): string {
  return JSON.stringify({
    currentBranch: git.currentBranch,
    headSha: git.headSha ?? null,
    aheadBehind: git.aheadBehind,
    isDirty: git.isDirty,
    diffStat: git.diffStat,
  });
}

/**
 * Offers Review at the end of a chat's turn when the turn changed the chat's checkout, so the
 * offer does not depend on the agent choosing to call `suggest_pimi_review`. The offer is a
 * notification on the chat's timeline carrying the checkout to open. It is written only when the
 * checkout differs from how the turn found it and from the state last offered, and not when the
 * agent already suggested a review during the turn. Only top-level chats the user talks to are
 * offered; the service reads git state and writes nothing else.
 */
export class ReviewSuggestionService {
  private readonly logger: Logger;
  private readonly agentManager: AgentManager;
  private readonly workspaceRegistry: ReviewSuggestionServiceOptions["workspaceRegistry"];
  private readonly workspaceGitService: ReviewSuggestionServiceOptions["workspaceGitService"];
  private readonly turns = new Map<string, TurnState>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  // The fingerprint last offered per chat, so an unchanged checkout is not offered again.
  private readonly lastSuggested = new Map<string, string>();
  private unsubscribe: (() => void) | null = null;

  constructor(options: ReviewSuggestionServiceOptions) {
    this.logger = options.logger.child({ module: "review-suggestion" });
    this.agentManager = options.agentManager;
    this.workspaceRegistry = options.workspaceRegistry;
    this.workspaceGitService = options.workspaceGitService;
  }

  start(): void {
    this.unsubscribe = this.agentManager.subscribe(
      (event) => {
        if (event.type === "agent_stream") {
          this.onStreamEvent(event.agentId, event.event);
          return;
        }
        if (event.type === "agent_removed") this.forget(event.agentId);
      },
      { replayState: false },
    );
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private onStreamEvent(agentId: string, event: AgentStreamEvent): void {
    switch (event.type) {
      case "turn_started":
        this.beginTurn(agentId);
        return;
      case "timeline": {
        const { item } = event;
        if (item.type !== "tool_call" || item.status !== "completed") return;
        const tool = resolvePimiToolLeaf(item.name, item.detail) ?? item.name;
        const turn = this.turns.get(agentId);
        if (turn && isPimiReviewSuggestionTool(tool)) turn.suggestedByAgent = true;
        return;
      }
      case "turn_completed":
        this.scheduleEvaluation(agentId);
        return;
      default:
        return;
    }
  }

  private beginTurn(agentId: string): void {
    this.clearTimer(agentId);
    const agent = this.agentManager.getAgent(agentId);
    if (!agent || !isUserChat(agent)) return;
    const previous = this.turns.get(agentId);
    this.turns.set(agentId, {
      generation: (previous?.generation ?? 0) + 1,
      start: this.readFingerprint(agent, false),
      suggestedByAgent: false,
    });
  }

  private scheduleEvaluation(agentId: string): void {
    const turn = this.turns.get(agentId);
    if (!turn) return;
    this.clearTimer(agentId);
    const { generation } = turn;
    this.timers.set(
      agentId,
      setTimeout(() => {
        this.timers.delete(agentId);
        void this.evaluate(agentId, generation).catch((error: unknown) => {
          this.logger.warn({ err: error, agentId }, "Review suggestion failed");
        });
      }, SETTLE_MS),
    );
  }

  // The snapshot at a turn's start is the cached one: the working-tree watcher keeps it current,
  // and the end of the turn always reads fresh. A stale start reading can only offer Review for
  // changes made outside the turn in the moment before it began.
  private async readFingerprint(agent: ManagedAgent, force: boolean): Promise<string | null> {
    const snapshot = await this.snapshotOf(agent, force);
    return snapshot?.git.isGit ? fingerprintOf(snapshot.git) : null;
  }

  private async snapshotOf(
    agent: ManagedAgent,
    force: boolean,
  ): Promise<WorkspaceGitRuntimeSnapshot | null> {
    const workspace = agent.workspaceId
      ? await this.workspaceRegistry.get(agent.workspaceId)
      : null;
    if (!workspace || workspace.archivedAt || !workspace.worktreeRoot) return null;
    try {
      return await this.workspaceGitService.getSnapshot(
        workspace.cwd,
        force
          ? { force: true, includeForge: false, reason: "review-suggestion" }
          : { includeForge: false },
      );
    } catch (error) {
      this.logger.warn(
        { err: error, agentId: agent.id, cwd: workspace.cwd },
        "Review suggestion could not read the checkout",
      );
      return null;
    }
  }

  private async evaluate(agentId: string, generation: number): Promise<void> {
    const turn = this.turns.get(agentId);
    if (!turn || turn.generation !== generation || turn.suggestedByAgent) return;
    const agent = this.agentManager.getAgent(agentId);
    if (!agent || !isUserChat(agent) || !agent.workspaceId) return;
    const workspace = await this.workspaceRegistry.get(agent.workspaceId);
    if (!workspace || workspace.archivedAt || !workspace.worktreeRoot) return;

    const [startFingerprint, snapshot] = await Promise.all([
      turn.start,
      this.snapshotOf(agent, true),
    ]);
    if (!snapshot?.git.isGit) return;
    const { git } = snapshot;
    const { diffStat } = git;
    const fingerprint = fingerprintOf(git);
    const changed = fingerprint !== startFingerprint;
    const alreadyOffered = fingerprint === this.lastSuggested.get(agentId);
    // A new turn began while the checkout was read; its own end evaluates it.
    const stale = this.turns.get(agentId)?.generation !== generation;
    if (!diffStat || !changed || alreadyOffered || stale) return;

    await this.agentManager.appendTimelineItem(agentId, {
      type: "notification",
      level: "info",
      message: SUGGESTION_MESSAGE,
      reviewSuggestion: {
        path: workspace.worktreeRoot,
        branch: git.currentBranch,
        // The exact ref is what the app compares against, so the review opens without waiting for status.
        baseRef: git.baseRefExact ?? git.baseRef,
        stats: {
          filesChanged: diffStat.filesChanged,
          additions: diffStat.additions,
          deletions: diffStat.deletions,
          incomplete: diffStat.incomplete,
        },
        origin: { agentId },
      },
    });
    this.lastSuggested.set(agentId, fingerprint);
  }

  private clearTimer(agentId: string): void {
    const timer = this.timers.get(agentId);
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(agentId);
  }

  private forget(agentId: string): void {
    this.clearTimer(agentId);
    this.turns.delete(agentId);
    this.lastSuggested.delete(agentId);
  }
}
