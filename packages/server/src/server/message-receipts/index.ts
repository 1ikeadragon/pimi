import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";
import { listStaleFiles } from "../stale-files.js";

// A receipt only has to outlive client retries of the same message id. Reconnect replays and
// offline-queued sends happen within hours to days; 30 days leaves a wide margin and keeps the
// directory to roughly a month of sends.
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

/** Owns message delivery receipts; creation is owned by CreationService. */
export class MessageReceipts {
  private readonly pending = new Map<string, Promise<void>>();
  private lastPruneAt = 0;
  constructor(private readonly directory: string) {}

  // Deletes receipts untouched for RECEIPT_RETENTION_MS, except a send still in flight.
  async prune(now = Date.now()): Promise<number> {
    this.lastPruneAt = now;
    let removed = 0;
    for (const file of await listStaleFiles(this.directory, RECEIPT_RETENTION_MS, now)) {
      if (!file.temp && this.pending.has(file.name.slice(0, -".json".length))) continue;
      await rm(file.path, { force: true });
      removed += 1;
    }
    return removed;
  }

  send(input: SendMessageInput): Promise<void> {
    if (Date.now() - this.lastPruneAt > PRUNE_INTERVAL_MS) {
      // Lazy: a daemon that sends nothing has nothing growing. Failure must not block a send.
      this.lastPruneAt = Date.now();
      void this.prune().catch(() => undefined);
    }
    // Preserve the existing on-disk identity and shape across daemon upgrades.
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
    const file = path.join(this.directory, `${key}.json`);
    const fingerprint = digest(input.request);
    const existing = await readReceipt(file);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("agent_request_key_conflict");
      if (existing.state === "completed") return;
      // A provider may have accepted the message before its receipt was committed.
      throw new Error("agent_request_outcome_unknown");
    }
    await input.prepare?.();
    const receipt = { fingerprint, agentId: input.agentId };
    await writeJsonFileAtomic(file, { ...receipt, state: "pending" });
    await input.send();
    await writeJsonFileAtomic(file, { ...receipt, state: "completed" });
  }
}

async function readReceipt(file: string): Promise<z.infer<typeof ReceiptSchema> | null> {
  try {
    return ReceiptSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
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
