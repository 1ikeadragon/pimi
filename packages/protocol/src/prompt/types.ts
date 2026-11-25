import { z } from "zod";

// The same cap as a project note (ProjectNoteTextSchema in the daemon's project-memory.ts): both
// are short text a person keeps to reuse, and neither is a place to park a document.
export const MAX_SAVED_PROMPT_TEXT_LENGTH = 4000;

// What a client sends to create or replace a saved prompt. `projectId` is a host-local project id,
// or null for a prompt that every project on the host can use.
export const SavedPromptDefinitionSchema = z.object({
  name: z.string(),
  text: z.string(),
  projectId: z.string().nullable(),
});
export type SavedPromptDefinition = z.infer<typeof SavedPromptDefinitionSchema>;

// A phrase the user keeps typing, found in their own chat history. `key` identifies the phrase
// for dismissal; `chats` is how many different chats it appeared in.
export const PromptSuggestionSchema = z.object({
  key: z.string(),
  text: z.string(),
  chats: z.number().int().positive(),
  lastUsedAt: z.string(),
});
export type PromptSuggestion = z.infer<typeof PromptSuggestionSchema>;

// `first`: what the user types to open a chat. `any`: anything they type often.
export const PromptSuggestionPositionSchema = z.enum(["first", "any"]);
export type PromptSuggestionPosition = z.infer<typeof PromptSuggestionPositionSchema>;

// A saved prompt is invoked as `/name`, so its name follows the flow naming rules.
export const SavedPromptSchema = z.object({
  id: z.string(),
  name: z.string(),
  text: z.string(),
  projectId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SavedPrompt = z.infer<typeof SavedPromptSchema>;
