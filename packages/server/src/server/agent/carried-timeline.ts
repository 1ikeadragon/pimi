import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { AgentTimelineItemPayloadSchema } from "@pimi/protocol/messages";
import { runJsonImportOnce, type PimiDatabase } from "../db/pimi-db.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

/** One timeline row a chat keeps from provider sessions it has since left. */
export type CarriedTimelineRow = Pick<AgentTimelineRow, "timestamp" | "item" | "turnId">;

/**
 * Timeline rows are runtime memory and a resumed agent rebuilds them from its
 * provider's history. After a provider switch that history starts at the
 * switch, so the rows from before it are kept here and replayed first.
 */
export interface CarriedTimelineStore {
  load(agentId: string): Promise<CarriedTimelineRow[] | null>;
  save(agentId: string, rows: readonly CarriedTimelineRow[]): Promise<void>;
  delete(agentId: string): Promise<void>;
}

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

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

const KIND = "carried_timeline";

// Rows of kind carried_timeline in the `records` table, one document per agent. The old
// agent-carried-timelines/<agentId>.json files are imported once and the directory is renamed to
// agent-carried-timelines.migrated.
export class SqlCarriedTimelineStore implements CarriedTimelineStore {
  private readonly logger: Logger;

  constructor(
    private readonly database: PimiDatabase,
    private readonly legacyDirectory: string,
    logger: Logger,
  ) {
    this.logger = logger.child({ module: "agent", component: "carried-timeline" });
  }

  async importLegacy(): Promise<void> {
    const items: Array<{ agentId: string; document: unknown }> = [];
    let names: string[] = [];
    try {
      names = await fs.readdir(this.legacyDirectory);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
      try {
        const document = CARRIED_TIMELINE_SCHEMA.parse(
          JSON.parse(await fs.readFile(path.join(this.legacyDirectory, name), "utf8")),
        );
        items.push({ agentId: name.slice(0, -".json".length), document });
      } catch (error) {
        this.logger.error({ err: error, name }, "Skipping invalid carried timeline file");
      }
    }
    await runJsonImportOnce(
      this.database,
      { name: "carried-timelines", legacyPaths: [this.legacyDirectory], logger: this.logger },
      () => {
        for (const item of items) this.write(item.agentId, item.document);
      },
    );
  }

  async load(agentId: string): Promise<CarriedTimelineRow[] | null> {
    const row = this.database.db
      .prepare("SELECT json FROM records WHERE kind = ? AND id = ?")
      .get(KIND, agentId);
    if (!row) return null;
    const parsed = CARRIED_TIMELINE_SCHEMA.safeParse(JSON.parse(String(row.json)));
    if (!parsed.success) {
      this.logger.error({ agentId, issues: parsed.error.issues }, "Invalid carried timeline");
      return null;
    }
    return parsed.data.rows;
  }

  async save(agentId: string, rows: readonly CarriedTimelineRow[]): Promise<void> {
    this.write(agentId, {
      version: 1,
      rows: rows.map(({ timestamp, item, turnId }) => ({
        timestamp,
        item,
        ...(turnId ? { turnId } : {}),
      })),
    });
  }

  async delete(agentId: string): Promise<void> {
    this.database.db.prepare("DELETE FROM records WHERE kind = ? AND id = ?").run(KIND, agentId);
  }

  private write(agentId: string, document: unknown): void {
    this.database.db
      .prepare(
        `INSERT INTO records (kind, id, parent_id, json) VALUES (?, ?, NULL, ?)
         ON CONFLICT(kind, id) DO UPDATE SET json = excluded.json`,
      )
      .run(KIND, agentId, JSON.stringify(document));
  }
}
