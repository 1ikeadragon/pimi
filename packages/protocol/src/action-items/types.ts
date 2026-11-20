import { z } from "zod";

export const ACTION_ITEM_TEXT_MAX_LENGTH = 200;
// The oldest done items are dropped first when a chat goes over.
export const ACTION_ITEMS_MAX_PER_CHAT = 100;

export const ActionItemTextSchema = z.string().trim().min(1).max(ACTION_ITEM_TEXT_MAX_LENGTH);

export const ActionItemAuthorSchema = z.enum(["model", "user"]);
export type ActionItemAuthor = z.infer<typeof ActionItemAuthorSchema>;

export const ActionItemSchema = z.object({
  id: z.string(),
  text: ActionItemTextSchema,
  done: z.boolean(),
  createdBy: ActionItemAuthorSchema,
  // Who last set `done`. A user's choice is final: the model never flips it back.
  doneSetBy: ActionItemAuthorSchema.optional(),
  createdAt: z.string(),
  completedAt: z.string().optional(),
});
export type ActionItem = z.infer<typeof ActionItemSchema>;

// What the Pimi model calls for this chat have used so far. `costUsd` is absent when the provider
// reports no cost.
export const ActionItemsUsageSchema = z.object({
  runs: z.number().int().nonnegative(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  costUsd: z.number().nonnegative().optional(),
});
export type ActionItemsUsage = z.infer<typeof ActionItemsUsageSchema>;

/**
 * `unset`: the chat has not finished a turn since action items existed, so nothing has read it.
 * `on`: the daemon reads new messages after each turn. `off`: the user paused it; items stay.
 */
export const ActionItemsTrackingSchema = z.enum(["unset", "on", "off"]);
export type ActionItemsTracking = z.infer<typeof ActionItemsTrackingSchema>;

export const ActionItemsStateSchema = z.object({
  agentId: z.string(),
  tracking: ActionItemsTrackingSchema,
  items: z.array(ActionItemSchema),
  // True while a model call for this chat is running.
  updating: z.boolean(),
  // The last model call's failure, cleared by the next one that succeeds.
  error: z.string().optional(),
  usage: ActionItemsUsageSchema,
});
export type ActionItemsState = z.infer<typeof ActionItemsStateSchema>;

export const ActionItemsEditSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("set_tracking"), tracking: z.boolean() }),
  z.object({ kind: z.literal("add"), text: ActionItemTextSchema }),
  z.object({ kind: z.literal("set_text"), itemId: z.string(), text: ActionItemTextSchema }),
  z.object({ kind: z.literal("set_done"), itemId: z.string(), done: z.boolean() }),
  z.object({ kind: z.literal("delete"), itemId: z.string() }),
  z.object({ kind: z.literal("clear_done") }),
]);
export type ActionItemsEdit = z.infer<typeof ActionItemsEditSchema>;

/** What `pimi.db` holds per chat; `id` is the agent id. */
export const StoredActionItemsSchema = z.object({
  id: z.string(),
  tracking: z.enum(["on", "off"]),
  items: z.array(ActionItemSchema),
  // The last timeline row the model has read. Absent until the first run.
  cursor: z.object({ epoch: z.string(), seq: z.number().int() }).optional(),
  error: z.string().optional(),
  usage: ActionItemsUsageSchema,
});
export type StoredActionItems = z.infer<typeof StoredActionItemsSchema>;
