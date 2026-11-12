import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { runJsonImportOnce, type PimiDatabase } from "../db/pimi-db.js";

// A receipt only has to outlive client retries of the same message id. Reconnect replays and
// offline-queued sends happen within hours to days; 30 days leaves a wide margin and keeps the
// table to roughly a month of sends.
const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60_000;

const ReceiptSchema = z.object({
  fingerprint: z.string(),
  state: z.enum(["pending", "completed"]),
  agentId: z.string(),
});
interface SendMessageInput {
  agentId: string;
  messageId: string;
  request: unknown;
  send: () => Promise<void>;
  prepare?: () => Promise<void>;
}

/** Owns message delivery receipts (kind `message` in the receipts table); creation is owned by CreationService. */
export class MessageReceipts {
  private readonly pending = new Map<string, Promise<void>>();
  private lastPruneAt = 0;
  constructor(
    private readonly database: PimiDatabase,
    private readonly legacyDirectory: string,
    private readonly logger: Logger,
  ) {}

  // Deletes receipts untouched for RECEIPT_RETENTION_MS, except a send still in flight.
  async prune(now = Date.now()): Promise<number> {
    this.lastPruneAt = now;
    let removed = 0;
    const stale = this.database.db
      .prepare("SELECT identity FROM receipts WHERE kind = 'message' AND updated_at < ?")
      .all(now - RECEIPT_RETENTION_MS) as Array<{ identity: string }>;
    for (const { identity } of stale) {
      if (this.pending.has(identity)) continue;
      this.database.db
        .prepare("DELETE FROM receipts WHERE kind = 'message' AND identity = ?")
        .run(identity);
      removed += 1;
    }
    return removed;
  }

  // The old $PIMI_HOME/agent-requests/<identity>.json files are imported once with their file
  // times and renamed to agent-requests.migrated.
  async importLegacy(): Promise<void> {
    const items: Array<{ identity: string; receipt: z.infer<typeof ReceiptSchema>; at: number }> =
      [];
    let names: string[] = [];
    try {
      names = await readdir(this.legacyDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
      const file = path.join(this.legacyDirectory, name);
      try {
        items.push({
          identity: name.slice(0, -".json".length),
          receipt: ReceiptSchema.parse(JSON.parse(await readFile(file, "utf8"))),
          at: (await stat(file)).mtimeMs,
        });
      } catch {
        // an unreadable receipt is dropped: the message id is then treated as new
      }
    }
    await runJsonImportOnce(
      this.database,
      { name: "message-receipts", legacyPaths: [this.legacyDirectory], logger: this.logger },
      () => {
        for (const item of items) this.write(item.identity, item.receipt, item.at);
      },
    );
  }

  private write(identity: string, receipt: z.infer<typeof ReceiptSchema>, at = Date.now()): void {
    this.database.db
      .prepare(
        `INSERT INTO receipts (kind, identity, updated_at, json) VALUES ('message', ?, ?, ?)
         ON CONFLICT(kind, identity) DO UPDATE SET updated_at = excluded.updated_at, json = excluded.json`,
      )
      .run(identity, Math.floor(at), JSON.stringify(receipt));
  }

  private read(identity: string): z.infer<typeof ReceiptSchema> | null {
    const row = this.database.db
      .prepare("SELECT json FROM receipts WHERE kind = 'message' AND identity = ?")
      .get(identity);
    return row ? ReceiptSchema.parse(JSON.parse(String(row.json))) : null;
  }

  send(input: SendMessageInput): Promise<void> {
    if (Date.now() - this.lastPruneAt > PRUNE_INTERVAL_MS) {
      // Lazy: a daemon that sends nothing has nothing growing. Failure must not block a send.
      this.lastPruneAt = Date.now();
      void this.prune().catch(() => undefined);
    }
    const key = digest(["send", input.agentId, input.messageId]);
    const previous = this.pending.get(key);
    const result = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() =>
      this.sendOnce(key, input),
    );
    this.pending.set(key, result);
    void result
      .finally(() => {
        if (this.pending.get(key) === result) this.pending.delete(key);
      })
      .catch(() => undefined);
    return result;
  }

  private async sendOnce(key: string, input: SendMessageInput): Promise<void> {
    const fingerprint = digest(input.request);
    const existing = this.read(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("agent_request_key_conflict");
      if (existing.state === "completed") return;
      // A provider may have accepted the message before its receipt was committed.
      throw new Error("agent_request_outcome_unknown");
    }
    await input.prepare?.();
    const receipt = { fingerprint, agentId: input.agentId };
    this.write(key, { ...receipt, state: "pending" });
    await input.send();
    this.write(key, { ...receipt, state: "completed" });
  }
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, candidate: unknown) => {
        if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
          return Object.fromEntries(
            Object.entries(candidate).sort(([a], [b]) => a.localeCompare(b)),
          );
        }
        return candidate;
      }),
    )
    .digest("hex");
}
