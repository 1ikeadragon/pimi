import type { Logger } from "pino";
import { AttackAuditEntrySchema, type AttackAuditEntry } from "@pimi/protocol/attack/types";
import type { PimiDatabase } from "../db/pimi-db.js";
import { SqlAuditLog } from "../db/sql-record-store.js";

const AUDIT_READ_LIMIT = 200;

// Append-only record of what an Attack run did: starts, budget stops, navigation refusals and
// finding ids. Entries carry ids, actions and short details only: never prompts, URLs with
// paths, evidence or agent output. Scope `attack:<runId>` in the `audit` table.
export class AttackAuditLog {
  private readonly log: SqlAuditLog<AttackAuditEntry>;
  private readonly logger: Logger;

  constructor(options: { database: PimiDatabase; runId: string; logger: Logger }) {
    this.log = new SqlAuditLog(options.database, `attack:${options.runId}`, AttackAuditEntrySchema);
    this.logger = options.logger;
  }

  async append(entry: Omit<AttackAuditEntry, "at">): Promise<void> {
    try {
      this.log.append(entry);
    } catch (error) {
      this.logger.error({ err: error, runId: entry.runId }, "Attack audit append failed");
    }
  }

  async read(limit = AUDIT_READ_LIMIT): Promise<AttackAuditEntry[]> {
    return this.log.read(limit);
  }
}
