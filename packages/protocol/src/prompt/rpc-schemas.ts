import { z } from "zod";
import {
  PromptSuggestionPositionSchema,
  PromptSuggestionSchema,
  SavedPromptDefinitionSchema,
  SavedPromptSchema,
} from "./types.js";

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

// Suggestions are computed on the host from its own chat history. `error` is set when the history
// could not be read; the list is then empty.
export const PromptSuggestionsListRequestSchema = z.object({
  type: z.literal("prompt.suggestions.list.request"),
  requestId: z.string(),
  projectId: z.string(),
  position: PromptSuggestionPositionSchema,
  limit: z.number().int().positive().optional(),
});
export const PromptSuggestionsListResponseSchema = z.object({
  type: z.literal("prompt.suggestions.list.response"),
  payload: z.object({
    requestId: z.string(),
    suggestions: z.array(PromptSuggestionSchema),
    error: z.string().nullable(),
  }),
});

export const PromptSuggestionsDismissRequestSchema = z.object({
  type: z.literal("prompt.suggestions.dismiss.request"),
  requestId: z.string(),
  projectId: z.string(),
  key: z.string(),
});
export const PromptSuggestionsDismissResponseSchema = z.object({
  type: z.literal("prompt.suggestions.dismiss.response"),
  payload: z.object({ requestId: z.string(), error: z.string().nullable() }),
});
