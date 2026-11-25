import { z } from "zod";
import { SavedPromptDefinitionSchema, SavedPromptSchema } from "./types.js";

const PromptIdRequestShape = { requestId: z.string(), promptId: z.string() };
const PromptPayloadSchema = z.object({ requestId: z.string(), prompt: SavedPromptSchema });

export const PromptListRequestSchema = z.object({
  type: z.literal("prompt.list.request"),
  requestId: z.string(),
});
export const PromptListResponseSchema = z.object({
  type: z.literal("prompt.list.response"),
  payload: z.object({ requestId: z.string(), prompts: z.array(SavedPromptSchema) }),
});

export const PromptCreateRequestSchema = z.object({
  type: z.literal("prompt.create.request"),
  requestId: z.string(),
  definition: SavedPromptDefinitionSchema,
});
export const PromptCreateResponseSchema = z.object({
  type: z.literal("prompt.create.response"),
  payload: PromptPayloadSchema,
});

export const PromptUpdateRequestSchema = z.object({
  type: z.literal("prompt.update.request"),
  ...PromptIdRequestShape,
  definition: SavedPromptDefinitionSchema,
});
export const PromptUpdateResponseSchema = z.object({
  type: z.literal("prompt.update.response"),
  payload: PromptPayloadSchema,
});

export const PromptDeleteRequestSchema = z.object({
  type: z.literal("prompt.delete.request"),
  ...PromptIdRequestShape,
});
export const PromptDeleteResponseSchema = z.object({
  type: z.literal("prompt.delete.response"),
  payload: z.object({ requestId: z.string(), promptId: z.string() }),
});
