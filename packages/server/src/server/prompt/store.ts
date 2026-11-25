import type { Logger } from "pino";
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
