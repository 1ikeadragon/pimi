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
