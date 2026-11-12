import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { AgentTimelineItemPayloadSchema } from "@pimi/protocol/messages";
import type { PimiDatabase } from "../db/pimi-db.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import type { SqliteTimelineStore } from "./sqlite-timeline-store.js";

const CARRIED_TIMELINE_SCHEMA = z.object({
  version: z.literal(1),
  rows: z.array(
    z.object({
      timestamp: z.string(),
      turnId: z.string().optional(),
      item: AgentTimelineItemPayloadSchema,
    }),
  ),
});

const IMPORT_KEY = "imported_carried_timelines";

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * One-time import of rows that earlier builds kept for chats that switched providers: one JSON
 * document per agent in pimi.db `records` (kind carried_timeline) and, for homes older still, the
 * agent-carried-timelines/<agentId>.json files. They become `carried` rows of the timeline file.
 * Gated by a meta row in pimi-timeline.db; the source rows and files are left where they are.
 */
export async function importCarriedTimelines(input: {
  pimiDatabase: PimiDatabase;
  timelineStore: SqliteTimelineStore;
  legacyDirectory: string;
  knownAgentIds: ReadonlySet<string>;
  logger: Logger;
}): Promise<void> {
  const { pimiDatabase, timelineStore, logger } = input;
  const timelineDb = timelineStore.database;
  if (timelineDb.db.prepare("SELECT 1 AS present FROM meta WHERE key = ?").get(IMPORT_KEY)) return;

  const documents = new Map<string, z.infer<typeof CARRIED_TIMELINE_SCHEMA>>();
  const recordRows = pimiDatabase.db
    .prepare("SELECT id, json FROM records WHERE kind = 'carried_timeline'")
    .all();
  for (const record of recordRows) {
    const agentId = String(record.id);
    try {
      documents.set(agentId, CARRIED_TIMELINE_SCHEMA.parse(JSON.parse(String(record.json))));
    } catch (error) {
      logger.error({ err: error, agentId }, "Skipping invalid carried timeline record");
    }
  }
  let names: string[] = [];
  try {
    names = await fs.readdir(input.legacyDirectory);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
    const agentId = name.slice(0, -".json".length);
    if (documents.has(agentId)) continue;
    try {
      documents.set(
        agentId,
        CARRIED_TIMELINE_SCHEMA.parse(
          JSON.parse(await fs.readFile(path.join(input.legacyDirectory, name), "utf8")),
        ),
      );
    } catch (error) {
      logger.error({ err: error, name }, "Skipping invalid carried timeline file");
    }
  }

  let imported = 0;
  for (const [agentId, document] of documents) {
    if (!input.knownAgentIds.has(agentId)) continue;
    const rows: AgentTimelineRow[] = [];
    for (const [index, row] of document.rows.entries()) {
      rows.push({
        seq: index + 1,
        timestamp: row.timestamp,
        item: row.item as AgentTimelineRow["item"],
        ...(row.turnId ? { turnId: row.turnId } : {}),
      });
    }
    timelineStore.importCarried(agentId, rows);
    imported += 1;
  }
  timelineDb.transaction(() => {
    timelineDb.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?)")
      .run(IMPORT_KEY, new Date().toISOString());
  });
  logger.info({ imported }, "Imported carried timelines into pimi-timeline.db");
}
