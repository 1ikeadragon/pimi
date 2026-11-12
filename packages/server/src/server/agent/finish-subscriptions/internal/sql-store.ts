import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { runJsonImportOnce, type PimiDatabase } from "../../../db/pimi-db.js";
import type { FinishSubscription, FinishSubscriptionStore } from "../index.js";
import type { Logger } from "pino";

const recordSchema = z.object({
  id: z.string().min(1),
  callerAgentId: z.string().min(1),
  childAgentId: z.string().min(1),
  serverId: z.string().min(1).optional(),
  requireParentOwnership: z.boolean().optional(),
});

const KIND = "finish_subscription";

// Rows of kind finish_subscription in the `records` table. Every call is one synchronous statement.
export function createSqlFinishSubscriptionStore(database: PimiDatabase): FinishSubscriptionStore {
  const db = database.db;
  return {
    list: async () =>
      db
        .prepare("SELECT json FROM records WHERE kind = ? ORDER BY rowid")
        .all(KIND)
        .map((row) => recordSchema.parse(JSON.parse(String(row.json)))),
    put: async (subscription: FinishSubscription) => {
      db.prepare(
        `INSERT INTO records (kind, id, parent_id, json) VALUES (?, ?, NULL, ?)
         ON CONFLICT(kind, id) DO UPDATE SET json = excluded.json`,
      ).run(KIND, subscription.id, JSON.stringify(recordSchema.parse(subscription)));
    },
    remove: async (id: string) => {
      db.prepare("DELETE FROM records WHERE kind = ? AND id = ?").run(KIND, id);
    },
  };
}

// The old $PIMI_HOME/finish-subscriptions.json is imported once and renamed with a .migrated suffix.
export async function importLegacyFinishSubscriptions(
  database: PimiDatabase,
  pimiHome: string,
  logger: Logger,
): Promise<void> {
  const file = join(pimiHome, "finish-subscriptions.json");
  let records: FinishSubscription[] = [];
  const present = (await readdir(pimiHome)).includes("finish-subscriptions.json");
  if (present) {
    try {
      records = z.array(recordSchema).parse(JSON.parse(await readFile(file, "utf8")));
    } catch (error) {
      logger.error({ err: error, file }, "Skipping invalid legacy finish subscriptions file");
    }
  }
  await runJsonImportOnce(
    database,
    { name: "finish-subscriptions", legacyPaths: [file], logger },
    () => {
      const insert = database.db.prepare(
        "INSERT INTO records (kind, id, parent_id, json) VALUES (?, ?, NULL, ?) ON CONFLICT(kind, id) DO UPDATE SET json = excluded.json",
      );
      for (const record of records) insert.run(KIND, record.id, JSON.stringify(record));
    },
  );
}
