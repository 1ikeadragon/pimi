import type { Logger } from "pino";
import type { AgentHandoffMarker } from "@pimi/protocol/agent-types";
import type { SqliteTimelineStore } from "../sqlite-timeline-store.js";
import {
  VERBATIM_BUDGET_CHARS,
  scanHistory,
  selectTail,
  type HandoffHistorySource,
  type HistoryEntry,
} from "./history.js";
import {
  HANDOFF_EXCERPT_CHARS,
  HANDOFF_TAIL_CHARS,
  buildHandoffMessage,
  type HandoffBody,
} from "./message.js";
import { runSummaryJob, type GenerateSummary } from "./summarizer.js";
import type { TranscriptStore } from "./transcript-file.js";
import { collectWorkState, type OpenTask } from "./work-state.js";

/** How long a prompt may be held for a summary: from the job's start, and as added delay. */
const MANUAL_DEADLINE_MS = 45_000;
const MANUAL_MAX_ADDED_MS = 15_000;
const LIMIT_DEADLINE_MS = 30_000;
/** The job itself gives up here. A result after the deadline is cached but not delivered. */
const JOB_TIMEOUT_MS = 90_000;

export interface HandoffControllerDeps {
  transcripts: TranscriptStore;
  archive: SqliteTimelineStore | undefined;
  readOpenTasks: (agentId: string) => Promise<OpenTask[]>;
  logger: Logger;
}

export interface PrepareHandoffInput {
  agentId: string;
  source: HandoffHistorySource;
  title: string | null;
  cwd: string;
  /** Labels of the provider and model the chat leaves and the ones it moves to. */
  sourceLabel: string;
  targetLabel: string;
  reason: "user" | "limit";
  inheritedContext: string | undefined;
  /** Writes the summary for this switch; absent when no model can be asked. */
  generate: GenerateSummary;
  /** Called with the finished message when a summary is ready before the prompt goes out. */
  onSummary: (message: string) => void;
}

export interface PreparedHandoff {
  /** Bring the transcript up to date again, for rows added since `prepare` (the switch marker). */
  refreshTranscript: () => void;
  /** The message to send if no summary arrives. */
  message: string;
  /** Set when history was cut, so there is nothing to wait for otherwise. */
  summarising: boolean;
  itemCount: number;
}

interface HandoffRecord {
  mode: "verbatim" | "excerpt";
  reason: "user" | "limit";
  transcriptPath: string;
  startedAt: number;
  /** The summary job; null when none was needed. */
  job: Promise<void> | null;
  settled: boolean;
  /** Its result is not applied: the history went out, or the switch was replaced. */
  cancelled: boolean;
  /** The switch was replaced or rolled back; the job stops instead of spending more calls. */
  superseded: boolean;
  summaryModel: string | null;
  summarised: boolean;
}

function describeSentMessage(message: string, transcriptPath: string): AgentHandoffMarker {
  const model = /^## Summary \(written by (.+)\), covers seq /m.exec(message)?.[1];
  if (model !== undefined || message.includes("\n## Summary")) {
    return { mode: "summary", ...(model ? { model } : {}), transcriptPath };
  }
  return {
    mode: message.includes("\n## Conversation\n") ? "verbatim" : "excerpt",
    transcriptPath,
  };
}

function joinInherited(entries: readonly HistoryEntry[], inherited: string | undefined) {
  if (!inherited) return entries;
  return [{ text: inherited, seqStart: 0, seqEnd: 0, turnStart: false }, ...entries];
}

/**
 * Prepares what a provider switch tells the next provider about the chat, without waiting on a
 * model: the rule-based message is ready when `prepare` returns, and a summary job finishes in the
 * background and replaces it through `onSummary`. The prompt that follows waits for the job only
 * until its deadline.
 */
export class HandoffController {
  private readonly records = new Map<string, HandoffRecord>();
  /** Chats with a summary job still running, including one whose prompt already went out. */
  private readonly running = new Set<string>();

  constructor(private readonly deps: HandoffControllerDeps) {}

  directory(agentId: string): string {
    return this.deps.transcripts.directory(agentId);
  }

  hasTranscript(agentId: string): boolean {
    return this.deps.transcripts.has(agentId);
  }

  /** Whether a summary job for this chat is still making model calls. */
  hasRunningJob(agentId: string): boolean {
    return this.running.has(agentId);
  }

  /** Whether a prompt for this chat has a summary job to wait for. */
  isSummarising(agentId: string): boolean {
    const record = this.records.get(agentId);
    return record?.job !== null && record?.job !== undefined && !record.settled;
  }

  cancel(agentId: string): void {
    const record = this.records.get(agentId);
    if (record) {
      record.cancelled = true;
      record.superseded = true;
    }
    this.records.delete(agentId);
  }

  async prepare(input: PrepareHandoffInput): Promise<PreparedHandoff> {
    this.cancel(input.agentId);
    const { agentId } = input;
    const directory = await this.deps.transcripts.ensureDirectory(agentId);
    const scan = await scanHistory(input.source);
    const workState = await collectWorkState({
      cwd: input.cwd,
      lastTodo: scan.lastTodo,
      readOpenTasks: () => this.deps.readOpenTasks(agentId),
    });
    // The transcript is written in the background; the message carries its path at once.
    const refreshTranscript = () =>
      void this.deps.transcripts
        .sync(input.source, {
          agentId,
          title: input.title,
          cwd: input.cwd,
          endpoint: input.targetLabel,
        })
        .catch((error) =>
          this.deps.logger.warn({ err: error, agentId }, "agent.handoff.transcript_failed"),
        );
    refreshTranscript();

    const base = {
      title: input.title,
      cwd: input.cwd,
      source: input.sourceLabel,
      switchedAt: new Date().toISOString(),
      reason: input.reason,
      workState,
      transcriptDirectory: directory,
    };
    const inheritedChars = input.inheritedContext?.length ?? 0;
    const record: HandoffRecord = {
      mode: "verbatim",
      reason: input.reason,
      transcriptPath: directory,
      startedAt: Date.now(),
      job: null,
      settled: true,
      cancelled: false,
      superseded: false,
      summaryModel: null,
      summarised: false,
    };
    if (scan.all && scan.totalChars + inheritedChars <= VERBATIM_BUDGET_CHARS) {
      this.records.set(agentId, record);
      return {
        message: buildHandoffMessage({
          ...base,
          body: { kind: "verbatim", entries: joinInherited(scan.all, input.inheritedContext) },
        }),
        summarising: false,
        itemCount: scan.entryCount,
        refreshTranscript,
      };
    }

    record.mode = "excerpt";
    const inheritedRequest = input.inheritedContext?.match(/^\[User\] .*$/m)?.[0] ?? null;
    const excerpt = selectTail(scan.tail, HANDOFF_EXCERPT_CHARS);
    const message = buildHandoffMessage({
      ...base,
      body: {
        kind: "excerpt",
        firstRequest: inheritedRequest ?? scan.firstRequest,
        entries: excerpt.entries,
      },
    });
    const tail = selectTail(scan.tail, HANDOFF_TAIL_CHARS);
    const throughSeq = tail.fromSeq - 1;
    const archive = this.deps.archive;
    if (!archive || !Number.isFinite(throughSeq) || throughSeq < 1) {
      this.records.set(agentId, record);
      return { message, summarising: false, itemCount: scan.entryCount, refreshTranscript };
    }

    const deadlineAt = record.startedAt + JOB_TIMEOUT_MS;
    record.settled = false;
    this.running.add(agentId);
    record.job = (async () => {
      try {
        const result = await runSummaryJob({
          agentId,
          source: input.source,
          archive,
          throughSeq,
          inheritedContext: input.inheritedContext,
          generate: input.generate,
          deadlineAt,
          isSuperseded: () => record.superseded,
          logger: this.deps.logger,
        });
        // A summary that arrives after the deadline but before the prompt still replaces the
        // excerpt: it costs the prompt no waiting. One that arrives after delivery is only cached.
        if (record.cancelled) {
          this.deps.logger.info({ agentId }, "agent.provider_switch.summary_not_delivered");
          return;
        }
        const body: HandoffBody = {
          kind: "summary",
          summary: result.summary,
          model: result.model,
          throughSeq,
          entries: tail.entries,
          lastSeq: scan.maxSeq,
        };
        record.summaryModel = result.model;
        record.summarised = true;
        input.onSummary(buildHandoffMessage({ ...base, body }));
      } catch (error) {
        this.deps.logger.warn({ err: error, agentId }, "agent.provider_switch.summary_failed");
      } finally {
        record.settled = true;
        this.running.delete(agentId);
      }
    })();
    this.records.set(agentId, record);
    return { message, summarising: true, itemCount: scan.entryCount, refreshTranscript };
  }

  private deadlineMs(reason: "user" | "limit"): number {
    return reason === "limit" ? LIMIT_DEADLINE_MS : MANUAL_DEADLINE_MS;
  }

  /**
   * Holds the first prompt after a switch while the summary is still being written: until the
   * job's deadline, and for a manual switch at most MANUAL_MAX_ADDED_MS. Never rejects.
   */
  async waitForSummary(agentId: string): Promise<void> {
    const record = this.records.get(agentId);
    if (!record?.job || record.settled) return;
    const untilDeadline = record.startedAt + this.deadlineMs(record.reason) - Date.now();
    const wait = Math.min(
      untilDeadline,
      record.reason === "limit" ? LIMIT_DEADLINE_MS : MANUAL_MAX_ADDED_MS,
    );
    if (wait <= 0) return;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, wait);
      timer.unref?.();
    });
    try {
      await Promise.race([record.job, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The history went out with a prompt. Returns what to record, then forgets the switch. After a
   * daemon restart the switch is forgotten already, and the mode is read back from the message.
   */
  delivered(agentId: string, sent: string): AgentHandoffMarker {
    const record = this.records.get(agentId);
    this.records.delete(agentId);
    if (!record) return describeSentMessage(sent, this.directory(agentId));
    // A job still running keeps its result for the next switch; it is not delivered here.
    record.cancelled = true;
    return {
      mode: record.summarised ? "summary" : record.mode,
      ...(record.summarised && record.summaryModel ? { model: record.summaryModel } : {}),
      transcriptPath: record.transcriptPath,
    };
  }

  removeTranscript(agentId: string): Promise<void> {
    this.cancel(agentId);
    return this.deps.transcripts.remove(agentId);
  }
}
