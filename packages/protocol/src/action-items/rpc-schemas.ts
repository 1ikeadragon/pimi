import { z } from "zod";
import { ActionItemsEditSchema, ActionItemsStateSchema } from "./types.js";

export const AgentActionItemsGetRequestSchema = z.object({
  type: z.literal("agent.action_items.get.request"),
  requestId: z.string(),
  agentId: z.string(),
});

export const AgentActionItemsEditRequestSchema = z.object({
  type: z.literal("agent.action_items.edit.request"),
  requestId: z.string(),
  agentId: z.string(),
  edit: ActionItemsEditSchema,
});

const StatePayloadSchema = z.object({ requestId: z.string(), state: ActionItemsStateSchema });

export const AgentActionItemsGetResponseSchema = z.object({
  type: z.literal("agent.action_items.get.response"),
  payload: StatePayloadSchema,
});

export const AgentActionItemsEditResponseSchema = z.object({
  type: z.literal("agent.action_items.edit.response"),
  payload: StatePayloadSchema,
});

// Pushed to connections subscribed to `agent.action_items.update` whenever a chat's list changes.
export const AgentActionItemsUpdateSchema = z.object({
  type: z.literal("agent.action_items.update"),
  payload: ActionItemsStateSchema,
});
