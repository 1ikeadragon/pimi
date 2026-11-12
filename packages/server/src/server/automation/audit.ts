import type { Logger } from "pino";
import {
  AutomationAuditEntrySchema,
  type AutomationAuditEntry,
} from "@pimi/protocol/automation/types";
import type { PimiDatabase } from "../db/pimi-db.js";
import { SqlAuditLog } from "../db/sql-record-store.js";

// Append-only record of what happened to each automation and who did it, in the `audit` table
// (scope `automation:<id>`, newest 2000 entries kept per automation). Entries carry ids, actions
// and short details only: never prompts or agent output.
export class AutomationAuditLog {
  private readonly database: PimiDatabase;
  private readonly logger: Logger;

  constructor(options: { database: PimiDatabase; logger: Logger }) {
    this.database = options.database;
    this.logger = options.logger;
  }

  private log(automationId: string): SqlAuditLog<AutomationAuditEntry> {
    return new SqlAuditLog(this.database, `automation:${automationId}`, AutomationAuditEntrySchema);
  }

  async append(entry: Omit<AutomationAuditEntry, "at">): Promise<void> {
    try {
      this.log(entry.automationId).append(entry);
    } catch (error) {
      this.logger.error({ err: error, automationId: entry.automationId }, "Audit append failed");
    }
  }

  async readForAutomation(automationId: string, limit: number): Promise<AutomationAuditEntry[]> {
    return this.log(automationId).read(limit);
  }
}
