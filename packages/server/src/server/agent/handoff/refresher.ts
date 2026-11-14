import type { Logger } from "pino";
import type { SqliteTimelineStore } from "../sqlite-timeline-store.js";
import {
  HANDOFF_FORMAT,
  VERBATIM_BUDGET_CHARS,
  scanHistory,
  selectTail,
  type HandoffHistorySource,
} from "./history.js";
import { HANDOFF_TAIL_CHARS } from "./message.js";
import { runSummaryJob, type GenerateSummary } from "./summarizer.js";

/** A turn must stay finished this long before the refresh looks at the chat. */
const IDLE_QUIET_MS = 20_000;
/** Per chat, between two refresh attempts (successful or not). */
const MIN_INTERVAL_MS = 10 * 60_000;
/** Curated characters after the checkpoint before it is worth another model call. */
const MIN_NEW_CHARS = 40_000;
/** How long a chat waits for the slot when another chat's refresh is running. */
const BUSY_RETRY_MS = 30_000;
/** A refresh runs up to four calls; this is the whole job's limit. */
const JOB_TIMEOUT_MS = 5 * 60_000;

export interface RefreshChat {
  source: HandoffHistorySource;
  /** The chat as it is when the refresh fires; null when it is busy, internal or gone. */
  probe: () => {
    cwd: string;
    provider: string;
    model: string | null;
    inheritedContext: string | undefined;
  } | null;
}

export interface HandoffRefresherDeps {
  archive: SqliteTimelineStore | undefined;
  createSummaryModel: (where: {
    cwd: string;
    target: { provider: string; model: string | null };
  }) => GenerateSummary;
  logger: Logger;
}

interface RunningJob {
  agentId: string;
  cancelled: boolean;
}

/**
 * Keeps each large chat's handoff checkpoint close to its history while it sits idle, so a
 * provider switch only summarises what came after it. One job at a time per daemon; a new turn
 * stops the chat's job between model calls.
 */
export class HandoffRefresher {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly lastAttempt = new Map<string, number>();
  private running: RunningJob | null = null;

  constructor(private readonly deps: HandoffRefresherDeps) {}

  /** A turn finished or the chat's history was loaded: look at it once it has stayed idle. */
  onIdle(agentId: string, chat: RefreshChat): void {
    if (!this.deps.archive) return;
    const last = this.lastAttempt.get(agentId) ?? 0;
    this.arm(agentId, chat, Math.max(IDLE_QUIET_MS, last + MIN_INTERVAL_MS - Date.now()));
  }

  private arm(agentId: string, chat: RefreshChat, wait: number): void {
    this.clearTimer(agentId);
    const timer = setTimeout(() => {
      this.timers.delete(agentId);
      // Another chat's job holds the single slot: look again shortly.
      if (this.running) {
        this.arm(agentId, chat, BUSY_RETRY_MS);
        return;
      }
      void this.refresh(agentId, chat).catch((error) =>
        this.deps.logger.warn({ err: error, agentId }, "agent.handoff.refresh_failed"),
      );
    }, wait);
    timer.unref?.();
    this.timers.set(agentId, timer);
  }

  /** The chat starts a turn, switches provider or goes away. */
  cancel(agentId: string): void {
    this.clearTimer(agentId);
    if (this.running?.agentId === agentId) this.running.cancelled = true;
  }

  private clearTimer(agentId: string): void {
    const timer = this.timers.get(agentId);
    if (timer) clearTimeout(timer);
    this.timers.delete(agentId);
  }

  private async refresh(agentId: string, chat: RefreshChat): Promise<void> {
    const archive = this.deps.archive;
    if (!archive || this.running) return;
    const now = chat.probe();
    if (!now) return;
    const job: RunningJob = { agentId, cancelled: false };
    this.running = job;
    try {
      const scan = await scanHistory(chat.source);
      if (scan.totalChars <= VERBATIM_BUDGET_CHARS) return;
      const tail = selectTail(scan.tail, HANDOFF_TAIL_CHARS);
      const throughSeq = tail.fromSeq - 1;
      if (!Number.isFinite(throughSeq) || throughSeq < 1) return;
      const checkpoint = archive.getHandoffCheckpoint(agentId);
      if (
        checkpoint &&
        checkpoint.epoch === scan.epoch &&
        checkpoint.format === HANDOFF_FORMAT &&
        checkpoint.throughSeq <= throughSeq
      ) {
        if (checkpoint.throughSeq === throughSeq) return;
        // The scan keeps the newest 48k characters, enough to measure up to the threshold.
        const newChars = scan.tail
          .filter((entry) => entry.seqEnd > checkpoint.throughSeq)
          .reduce((total, entry) => total + entry.text.length + 1, 0);
        if (newChars < MIN_NEW_CHARS) return;
      }
      if (job.cancelled) return;
      this.lastAttempt.set(agentId, Date.now());
      const startedAt = Date.now();
      const result = await runSummaryJob({
        agentId,
        source: chat.source,
        archive,
        throughSeq,
        inheritedContext: now.inheritedContext,
        generate: this.deps.createSummaryModel({
          cwd: now.cwd,
          target: { provider: now.provider, model: now.model },
        }),
        deadlineAt: startedAt + JOB_TIMEOUT_MS,
        isSuperseded: () => job.cancelled,
        logger: this.deps.logger,
      });
      this.deps.logger.info(
        { agentId, throughSeq, calls: result.calls, elapsedMs: Date.now() - startedAt },
        "agent.handoff.checkpoint_refreshed",
      );
    } finally {
      this.running = null;
    }
  }
}
