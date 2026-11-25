import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import {
  ACTION_ITEMS_MAX_PER_CHAT,
  StoredActionItemsSchema,
  type ActionItem,
  type ActionItemsEdit,
  type ActionItemsState,
  type ActionItemsUsage,
  type StoredActionItems,
} from "@pimi/protocol/action-items/types";
import { PARENT_AGENT_ID_LABEL } from "@pimi/protocol/agent-labels";
import type { AgentManager, ManagedAgent } from "../agent/agent-manager.js";
import { loggableError } from "../agent/agent-response-loop.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { PimiDatabase } from "../db/pimi-db.js";
import { SqlRecordStore } from "../db/sql-record-store.js";
import type { ActionItemChanges, ChatMessage } from "./generate.js";

export class ActionItemsError extends Error {
  constructor(
    readonly code: "action_item_not_found" | "action_items_disabled" | "action_items_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "ActionItemsError";
  }
}

// A turn's end waits this long before the model call, so a queued follow-up prompt that starts
// the next turn right away is read together with it.
export const SETTLE_MS = 2500;
// Text of new messages sent in one model call. More than this is read in further calls, in order.
const CALL_CHARS = 24_000;
// A chat tracked for the first time is read from its tail only: at most this much text.
const FIRST_READ_CHARS = 48_000;
// A longer message keeps its head and tail; the middle of a long reply is detail, not intent.
const MESSAGE_HEAD_CHARS = 4000;
const MESSAGE_TAIL_CHARS = 2000;

const EMPTY_USAGE: ActionItemsUsage = { runs: 0, inputTokens: 0, outputTokens: 0 };

// Set by automation/service.ts on every agent an automation run creates.
const AUTOMATION_RUN_LABEL = "pimi.automation-run";

const NO_SMALL_MODEL =
  "This chat's provider has no small model. Choose a model for Action items in Settings.";

export interface ChatKind {
  background?: boolean | undefined;
  internal?: boolean | undefined;
  labels: Record<string, string>;
}

// A top-level chat the user talks to: not a subagent, background agent, Pimi helper or automation
// step. Heartbeats are checked separately, since they attach to a chat after it exists.
export function isUserChat(agent: ChatKind): boolean {
  return (
    !agent.background &&
    !agent.internal &&
    !agent.labels[PARENT_AGENT_ID_LABEL] &&
    !agent.labels[AUTOMATION_RUN_LABEL]
  );
}

function clip(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MESSAGE_HEAD_CHARS + MESSAGE_TAIL_CHARS) return trimmed;
  return `${trimmed.slice(0, MESSAGE_HEAD_CHARS)}\n[...]\n${trimmed.slice(-MESSAGE_TAIL_CHARS)}`;
}

function textKey(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function sumUsage(a: ActionItemsUsage, b: ActionItemsUsage): ActionItemsUsage {
  return {
    runs: a.runs + b.runs,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(a.costUsd !== undefined || b.costUsd !== undefined
      ? { costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0) }
      : {}),
  };
}

// Over the cap, the oldest done items go first; open items are never dropped.
function capItems(items: ActionItem[]): ActionItem[] {
  let excess = items.length - ACTION_ITEMS_MAX_PER_CHAT;
  if (excess <= 0) return items;
  return items.filter((item) => {
    if (excess > 0 && item.done) {
      excess -= 1;
      return false;
    }
    return true;
  });
}

interface Batch {
  messages: ChatMessage[];
  cursor: { epoch: string; seq: number };
  more: boolean;
}

export interface ActionItemsServiceOptions {
  database: PimiDatabase;
  logger: Logger;
  agentManager: AgentManager;
  agentStorage: Pick<AgentStorage, "get">;
  hasHeartbeat: (agentId: string) => Promise<boolean>;
  isEnabled: () => boolean;
  /** Null when no model may read this chat. */
  generate: (input: {
    agent: ManagedAgent;
    items: readonly ActionItem[];
    messages: readonly ChatMessage[];
  }) => Promise<ActionItemChanges | null>;
}

/**
 * Per-chat action items: `action_items` rows in pimi.db, keyed by agent id. A chat is read by a
 * Pimi model once per turn it finishes while the daemon runs, unless the user paused it, and each
 * call gets the current list plus the messages after the stored cursor. A chat that never
 * finishes a turn is never read, so opening old chats costs nothing. Only top-level chats the user
 * talks to are read: subagents, background agents, automation steps and chats with a heartbeat
 * are skipped. The service only reads the timeline; nothing is written to the chat or sent to its
 * agent.
 */
export class ActionItemsService {
  private readonly store: SqlRecordStore<StoredActionItems>;
  private readonly logger: Logger;
  private readonly agentManager: AgentManager;
  private readonly agentStorage: Pick<AgentStorage, "get">;
  private readonly hasHeartbeat: (agentId: string) => Promise<boolean>;
  private readonly isEnabled: () => boolean;
  private readonly generate: ActionItemsServiceOptions["generate"];
  private readonly listeners = new Set<(state: ActionItemsState) => void>();
  // Agent ids the user paused, so their turn ends cost one Set lookup and no read.
  private readonly paused = new Set<string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly running = new Set<string>();
  private readonly rerun = new Set<string>();
  // Deleted chats, so a model call or edit that finishes after the delete never writes a new row.
  // Agent ids are never reused; the set grows by one id per chat deleted while the daemon runs.
  private readonly removed = new Set<string>();
  private unsubscribe: (() => void) | null = null;

  constructor(options: ActionItemsServiceOptions) {
    this.logger = options.logger.child({ module: "action-items" });
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.hasHeartbeat = options.hasHeartbeat;
    this.isEnabled = options.isEnabled;
    this.generate = options.generate;
    this.store = new SqlRecordStore({
      database: options.database,
      kind: "action_items",
      schema: StoredActionItemsSchema,
      logger: this.logger,
      label: "action items",
    });
  }

  async start(): Promise<void> {
    for (const record of await this.store.list()) {
      if (record.tracking === "off") this.paused.add(record.id);
    }
    this.unsubscribe = this.agentManager.subscribe(
      (event) => {
        if (event.type === "agent_stream") {
          if (event.event.type === "turn_completed" && this.shouldRead(event.agentId)) {
            void this.scheduleUnlessHeartbeat(event.agentId);
          }
          return;
        }
        if (event.type === "agent_removed") void this.remove(event.agentId);
      },
      { replayState: false },
    );
  }

  // Checked as the turn ends: the heartbeat lookup reads the database before its first await, so a
  // one-time heartbeat that sent this turn is still there. It is deleted once the turn ends.
  private async scheduleUnlessHeartbeat(agentId: string): Promise<void> {
    try {
      if (!(await this.hasHeartbeat(agentId))) this.schedule(agentId);
    } catch (error) {
      this.logger.warn({ err: error, agentId }, "Action items heartbeat check failed");
    }
  }

  private shouldRead(agentId: string): boolean {
    if (this.paused.has(agentId) || !this.isEnabled()) return false;
    const agent = this.agentManager.getAgent(agentId);
    return Boolean(agent && isUserChat(agent));
  }

  // Edits are for chats that exist and that action items read; an unloaded chat is found on disk.
  private async requireUserChat(agentId: string): Promise<void> {
    const agent =
      this.agentManager.getAgent(agentId) ?? (await this.agentStorage.get(agentId)) ?? null;
    if (!agent || this.removed.has(agentId) || !isUserChat(agent)) {
      throw new ActionItemsError(
        "action_items_unavailable",
        "Action items are only kept for your own top-level chats.",
      );
    }
  }

  private async create(
    agentId: string,
    tracking: StoredActionItems["tracking"],
  ): Promise<StoredActionItems | null> {
    if (this.removed.has(agentId)) return null;
    return this.store.put({ id: agentId, tracking, items: [], usage: EMPTY_USAGE });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  onChanged(listener: (state: ActionItemsState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async get(agentId: string): Promise<ActionItemsState> {
    return this.project(agentId, await this.store.get(agentId));
  }

  async edit(agentId: string, edit: ActionItemsEdit): Promise<ActionItemsState> {
    if (!this.isEnabled()) {
      throw new ActionItemsError("action_items_disabled", "Action items are turned off.");
    }
    await this.requireUserChat(agentId);
    if (edit.kind === "set_tracking") return this.setTracking(agentId, edit.tracking);
    const existing = await this.store.get(agentId);
    if (!existing && (edit.kind !== "add" || !(await this.create(agentId, "on")))) {
      throw new ActionItemsError("action_item_not_found", "That item no longer exists.");
    }
    const next = await this.store.update(agentId, (record) => ({
      ...record,
      items: capItems(applyEdit(record.items, edit)),
    }));
    return this.publish(agentId, next);
  }

  private async setTracking(agentId: string, tracking: boolean): Promise<ActionItemsState> {
    const value = tracking ? ("on" as const) : ("off" as const);
    const existing = await this.store.get(agentId);
    const next = existing
      ? await this.store.update(agentId, (record) => ({ ...record, tracking: value }))
      : await this.create(agentId, value);
    if (!next) throw new ActionItemsError("action_items_unavailable", "That chat was deleted.");
    if (tracking) {
      this.paused.delete(agentId);
      this.schedule(agentId, 0);
    } else {
      this.paused.add(agentId);
      this.cancelTimer(agentId);
    }
    return this.publish(agentId, next);
  }

  private async remove(agentId: string): Promise<void> {
    this.removed.add(agentId);
    this.paused.delete(agentId);
    this.cancelTimer(agentId);
    try {
      await this.store.delete(agentId);
    } catch (error) {
      this.logger.error({ err: error, agentId }, "Action items cleanup failed");
    }
  }

  private cancelTimer(agentId: string): void {
    const timer = this.timers.get(agentId);
    if (timer) clearTimeout(timer);
    this.timers.delete(agentId);
  }

  private schedule(agentId: string, delayMs = SETTLE_MS): void {
    this.cancelTimer(agentId);
    this.timers.set(
      agentId,
      setTimeout(() => {
        this.timers.delete(agentId);
        void this.run(agentId);
      }, delayMs),
    );
  }

  private project(agentId: string, record: StoredActionItems | null): ActionItemsState {
    return {
      agentId,
      tracking: record?.tracking ?? "unset",
      items: record?.items ?? [],
      updating: this.running.has(agentId),
      ...(record?.error ? { error: record.error } : {}),
      usage: record?.usage ?? EMPTY_USAGE,
    };
  }

  private publish(agentId: string, record: StoredActionItems | null): ActionItemsState {
    const state = this.project(agentId, record);
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch (error) {
        this.logger.error({ err: error }, "Action items listener failed");
      }
    }
    return state;
  }

  // One chat runs one model call at a time; a turn that ends meanwhile queues one more pass.
  private async run(agentId: string): Promise<void> {
    if (this.running.has(agentId)) {
      this.rerun.add(agentId);
      return;
    }
    this.running.add(agentId);
    try {
      await this.catchUp(agentId);
    } catch (error) {
      this.logger.warn({ err: loggableError(error), agentId }, "Action items update failed");
      const message = error instanceof Error ? error.message : String(error);
      await this.store
        .update(agentId, (record) => ({ ...record, error: message.slice(0, 500) }))
        .catch(() => null);
    } finally {
      this.running.delete(agentId);
      this.publish(agentId, await this.store.get(agentId).catch(() => null));
      if (this.rerun.delete(agentId) && this.shouldRead(agentId)) this.schedule(agentId);
    }
  }

  private async catchUp(agentId: string): Promise<void> {
    for (;;) {
      if (!this.isEnabled()) return;
      const agent = this.agentManager.getAgent(agentId);
      // An unloaded chat has no new turns. A running one is read when its turn ends, so a reply
      // is never read half-streamed. Nothing is stored for a chat that is not read.
      if (!agent || agent.lifecycle === "running" || !isUserChat(agent)) return;
      if (await this.hasHeartbeat(agentId)) return;
      const record = (await this.store.get(agentId)) ?? (await this.create(agentId, "on"));
      if (!record || record.tracking !== "on") return;
      const batch = this.readBatch(agentId, record.cursor);
      if (!batch) return;
      if (batch.messages.length === 0) {
        await this.store.update(agentId, (current) => ({ ...current, cursor: batch.cursor }));
        if (!batch.more) return;
        continue;
      }
      this.publish(agentId, record);
      const changes = await this.generate({ agent, items: record.items, messages: batch.messages });
      if (!changes) {
        await this.store.update(agentId, (current) => ({ ...current, error: NO_SMALL_MODEL }));
        return;
      }
      // Applied to the record as it is now, so an edit made during the call survives.
      await this.store.update(agentId, (current) => {
        const { error: _cleared, ...rest } = current;
        return {
          ...rest,
          items: capItems(applyChanges(current.items, changes)),
          cursor: batch.cursor,
          usage: sumUsage(current.usage, changes.usage),
        };
      });
      if (!batch.more) return;
    }
  }

  // The user and assistant text after the cursor, up to CALL_CHARS. Tool calls and reasoning are
  // skipped. Null when the chat has no rows.
  private readBatch(agentId: string, cursor: StoredActionItems["cursor"]): Batch | null {
    const page = this.agentManager.fetchTimeline(
      agentId,
      cursor ? { direction: "after", cursor, limit: 0 } : { direction: "tail", limit: 0 },
    );
    if (page.rows.length === 0) return null;
    // No cursor, or one from a replaced timeline: start from the tail, bounded.
    if (!cursor || page.reset) {
      const messages: ChatMessage[] = [];
      let chars = 0;
      for (let index = page.rows.length - 1; index >= 0 && chars < FIRST_READ_CHARS; index -= 1) {
        const message = toMessage(page.rows[index]?.item);
        if (!message) continue;
        messages.unshift(message);
        chars += message.text.length;
      }
      const last = page.rows[page.rows.length - 1];
      return { messages, cursor: { epoch: page.epoch, seq: last?.seq ?? 0 }, more: false };
    }
    const messages: ChatMessage[] = [];
    let chars = 0;
    let seq = cursor.seq;
    let taken = 0;
    for (const row of page.rows) {
      if (chars >= CALL_CHARS) break;
      taken += 1;
      seq = row.seq;
      const message = toMessage(row.item);
      if (!message) continue;
      messages.push(message);
      chars += message.text.length;
    }
    return { messages, cursor: { epoch: page.epoch, seq }, more: taken < page.rows.length };
  }
}

function toMessage(item: { type: string; text?: string } | undefined): ChatMessage | null {
  if (!item || (item.type !== "user_message" && item.type !== "assistant_message")) return null;
  const text = clip(item.text ?? "");
  if (!text) return null;
  return { role: item.type === "user_message" ? "user" : "assistant", text };
}

function requireItem(items: readonly ActionItem[], itemId: string): ActionItem {
  const item = items.find((entry) => entry.id === itemId);
  if (!item) throw new ActionItemsError("action_item_not_found", "That item no longer exists.");
  return item;
}

function setDone(item: ActionItem, done: boolean, by: "model" | "user", now: string): ActionItem {
  const { completedAt: _completedAt, ...rest } = item;
  return { ...rest, done, doneSetBy: by, ...(done ? { completedAt: now } : {}) };
}

function applyEdit(
  items: readonly ActionItem[],
  edit: Exclude<ActionItemsEdit, { kind: "set_tracking" }>,
): ActionItem[] {
  const now = new Date().toISOString();
  switch (edit.kind) {
    case "add":
      return [
        ...items,
        { id: randomUUID(), text: edit.text, done: false, createdBy: "user", createdAt: now },
      ];
    case "set_text":
      requireItem(items, edit.itemId);
      return items.map((item) => (item.id === edit.itemId ? { ...item, text: edit.text } : item));
    case "set_done":
      requireItem(items, edit.itemId);
      return items.map((item) =>
        item.id === edit.itemId ? setDone(item, edit.done, "user", now) : item,
      );
    case "delete":
      requireItem(items, edit.itemId);
      return items.filter((item) => item.id !== edit.itemId);
    case "clear_done":
      return items.filter((item) => !item.done);
  }
}

// The model's changes. An item the user checked or unchecked keeps the user's choice, and an
// added line that repeats an existing item is dropped.
function applyChanges(items: readonly ActionItem[], changes: ActionItemChanges): ActionItem[] {
  const now = new Date().toISOString();
  const doneById = new Map(changes.update.map((entry) => [entry.itemId, entry.done]));
  const next = items.map((item) => {
    const done = doneById.get(item.id);
    if (done === undefined || done === item.done || item.doneSetBy === "user") return item;
    return setDone(item, done, "model", now);
  });
  const known = new Set(next.map((item) => textKey(item.text)));
  for (const entry of changes.add) {
    const key = textKey(entry.text);
    if (!key || known.has(key)) continue;
    known.add(key);
    next.push({
      id: randomUUID(),
      text: entry.text,
      done: entry.done,
      createdBy: "model",
      createdAt: now,
      ...(entry.done ? { doneSetBy: "model" as const, completedAt: now } : {}),
    });
  }
  return next;
}
