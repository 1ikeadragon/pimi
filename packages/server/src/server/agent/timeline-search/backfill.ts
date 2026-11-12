import type { Logger } from "pino";
import type { ChatSearchIndexResponse } from "@pimi/protocol/chat-search";
import type { PimiDatabase } from "../../db/pimi-db.js";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage } from "../agent-storage.js";
import { ensureAgentLoaded } from "../agent-loading.js";
import type { SqliteTimelineStore } from "../sqlite-timeline-store.js";
import type { TimelineIndexer } from "./indexer.js";

const POLL_MS = 250;
const PAUSE_POLL_MS = 2000;
/** Longest one chat may take to be read to its start before the run moves on. */
const PER_CHAT_TIMEOUT_MS = 10 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type BackfillManager = Pick<
  AgentManager,
  | "createAgent"
  | "getAgent"
  | "getRegisteredProviderIds"
  | "hydrateTimelineFromProvider"
  | "resumeAgentFromPersistence"
  | "waitForAgentClose"
  | "closeAgent"
  | "listAgents"
>;

/**
 * "Index older chats": opens each chat whose timeline was never stored, newest first and one at
 * a time, lets it read its provider history to the start (which stores and indexes it), and
 * closes it again if nothing else had it open. Pauses while any agent runs a turn. Progress is
 * the stored state itself (a finished chat is `complete`), so a daemon restart resumes the run
 * by starting it again.
 */
export class ChatIndexBackfill {
  private state: Omit<ChatSearchIndexResponse, "requestId"> = {
    running: false,
    done: 0,
    total: 0,
    skipped: [],
    error: null,
  };
  private cancelled = false;
  private readonly logger: Logger;

  constructor(
    private readonly options: {
      store: SqliteTimelineStore;
      indexer: TimelineIndexer;
      agentManager: BackfillManager;
      agentStorage: AgentStorage;
      pimiDatabase: PimiDatabase;
      logger: Logger;
    },
  ) {
    this.logger = options.logger.child({ module: "agent", component: "chat-index-backfill" });
  }

  status(): Omit<ChatSearchIndexResponse, "requestId"> {
    return { ...this.state, skipped: [...this.state.skipped] };
  }

  /** Chats that are not stored completely yet, newest first. */
  private pendingAgentIds(): string[] {
    return this.options.pimiDatabase.db
      .prepare(
        `SELECT id FROM agents WHERE internal = 0
            AND id NOT IN (SELECT agent_id FROM timeline_agents WHERE complete = 1)
          ORDER BY COALESCE(last_user_message_at, updated_at) DESC`,
      )
      .all()
      .map((row) => String(row.id));
  }

  start(): Omit<ChatSearchIndexResponse, "requestId"> {
    if (this.state.running) return this.status();
    const pending = this.pendingAgentIds();
    this.cancelled = false;
    this.state = { running: true, done: 0, total: pending.length, skipped: [], error: null };
    void this.run(pending);
    return this.status();
  }

  stop(): void {
    this.cancelled = true;
  }

  private async run(pending: string[]): Promise<void> {
    try {
      for (const agentId of pending) {
        if (this.cancelled) break;
        while (this.anyAgentRunning() && !this.cancelled) await sleep(PAUSE_POLL_MS);
        if (this.cancelled) break;
        await this.indexOne(agentId);
        this.state.done += 1;
      }
    } catch (error) {
      this.state.error = error instanceof Error ? error.message : String(error);
      this.logger.error({ err: error }, "Index older chats stopped");
    } finally {
      this.state.running = false;
    }
  }

  private anyAgentRunning(): boolean {
    return this.options.agentManager
      .listAgents()
      .some((agent) => agent.lifecycle === "running" || agent.lifecycle === "initializing");
  }

  private async indexOne(agentId: string): Promise<void> {
    const { agentManager, agentStorage, store, indexer } = this.options;
    const wasLoaded = agentManager.getAgent(agentId) !== null;
    try {
      await ensureAgentLoaded(agentId, {
        agentManager,
        agentStorage,
        purpose: "history",
        logger: this.logger,
      });
      const deadline = Date.now() + PER_CHAT_TIMEOUT_MS;
      while (!store.getAgent(agentId)?.complete && Date.now() < deadline && !this.cancelled) {
        // A windowed history stores its older blocks in the background once the chat is idle.
        if (!agentManager.getAgent(agentId)) break;
        await sleep(POLL_MS);
      }
      await indexer.idle();
      if (!store.getAgent(agentId)?.complete) {
        this.state.skipped.push({ agentId, reason: "Its history could not be read to the start" });
      }
    } catch (error) {
      this.state.skipped.push({
        agentId,
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (!wasLoaded) {
        await agentManager.closeAgent(agentId).catch((error: unknown) => {
          this.logger.warn({ err: error, agentId }, "Failed to close chat after indexing it");
        });
      }
    }
  }
}
