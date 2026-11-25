import { createHash } from "node:crypto";
import type { Logger } from "pino";
import { z } from "zod";
import { SavedPromptSchema, type SavedPrompt } from "@pimi/protocol/prompt/types";
import type { PimiDatabase } from "../db/pimi-db.js";
import { SqlRecordStore } from "../db/sql-record-store.js";

// Rows in pimi.db: kind `saved_prompt`. A prompt belongs to one project or to the whole host.
export function createSavedPromptStore(options: {
  database: PimiDatabase;
  logger: Logger;
}): SqlRecordStore<SavedPrompt> {
  return new SqlRecordStore({
    database: options.database,
    kind: "saved_prompt",
    schema: SavedPromptSchema,
    logger: options.logger,
    label: "saved prompt",
  });
}

export const SuggestionDismissalSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  key: z.string(),
  dismissedAt: z.string(),
});
export type SuggestionDismissal = z.infer<typeof SuggestionDismissalSchema>;

// A record id is limited to letters, digits, `_` and `-`, and a project id can be any string a host
// registered, so the id is a hash of the pair.
export function suggestionDismissalId(projectId: string, key: string): string {
  return createHash("sha256").update(`${projectId}\0${key}`).digest("hex");
}

// Rows in pimi.db: kind `prompt_suggestion_dismissal`. A dismissed phrase stays out of that
// project's suggestions; the host's chat history is never edited.
export function createSuggestionDismissalStore(options: {
  database: PimiDatabase;
  logger: Logger;
}): SqlRecordStore<SuggestionDismissal> {
  return new SqlRecordStore({
    database: options.database,
    kind: "prompt_suggestion_dismissal",
    schema: SuggestionDismissalSchema,
    logger: options.logger,
    label: "prompt suggestion dismissal",
  });
}
