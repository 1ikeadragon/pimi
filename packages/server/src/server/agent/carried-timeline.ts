import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { AgentTimelineItemPayloadSchema } from "@pimi/protocol/messages";
import { writeJsonFileAtomic } from "../atomic-file.js";
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

export class FileCarriedTimelineStore implements CarriedTimelineStore {
  private readonly logger: Logger;

  constructor(
    private readonly directory: string,
    logger: Logger,
  ) {
    this.logger = logger.child({ module: "agent", component: "carried-timeline" });
  }

  async load(agentId: string): Promise<CarriedTimelineRow[] | null> {
    const filePath = this.filePath(agentId);
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
    const parsed = CARRIED_TIMELINE_SCHEMA.safeParse(JSON.parse(content));
    if (!parsed.success) {
      this.logger.error(
        { agentId, filePath, issues: parsed.error.issues },
        "Invalid carried timeline",
      );
      return null;
    }
    return parsed.data.rows;
  }

  async save(agentId: string, rows: readonly CarriedTimelineRow[]): Promise<void> {
    await writeJsonFileAtomic(this.filePath(agentId), {
      version: 1,
      rows: rows.map(({ timestamp, item, turnId }) => ({
        timestamp,
        item,
        ...(turnId ? { turnId } : {}),
      })),
    });
  }

  async delete(agentId: string): Promise<void> {
    await fs.rm(this.filePath(agentId), { force: true });
  }

  private filePath(agentId: string): string {
    return path.join(this.directory, `${agentId}.json`);
  }
}
