import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

// ---
// Codex writes `rate_limits` into every `token_count` event of a rollout, so the newest rollout
// holds the account's limits as of its last request. That is the fallback when the usage API
// cannot be asked (expired or rejected login, outage).
//
// Measured on 184 rollouts on one machine: a token_count line is at most 746 bytes, and the last
// event that carries a window sits at most 87 KB from the end of its file (95th percentile 17 KB).
// 256 KiB is three times that maximum, so one bounded read finds it without loading a rollout that
// can run to hundreds of megabytes.
const ROLLOUT_TAIL_BYTES = 256 * 1024;

// 4 of those 184 rollouts (2%) have no event with a window, because the session ended before its
// first request. Five newest files make five such empties in a row a one-in-ten-billion case.
const MAX_ROLLOUTS_TRIED = 5;

// The account-wide bucket. Codex's app-server schema names it as the example `limit_id` and every
// rollout on the reference machine carries it; other buckets are model-specific extras.
const RATE_LIMITS_BUCKET = "codex";

const windowSchema = z.object({
  used_percent: z.number().finite(),
  window_minutes: z.number().finite().nullish(),
  resets_at: z.number().finite().nullish(),
});
const rateLimitsSchema = z.object({
  limit_id: z.string().nullish(),
  primary: windowSchema.nullish(),
  secondary: windowSchema.nullish(),
  credits: z
    .object({
      has_credits: z.boolean().optional(),
      unlimited: z.boolean().optional(),
      balance: z.coerce.number().finite().nullish(),
    })
    .nullish(),
  plan_type: z.string().nullish(),
});
const eventSchema = z.object({
  timestamp: z.string(),
  payload: z.object({ type: z.literal("token_count"), rate_limits: rateLimitsSchema.nullish() }),
});

export type RolloutWindow = z.infer<typeof windowSchema>;
export type RolloutRateLimits = z.infer<typeof rateLimitsSchema>;

export interface RolloutSnapshot {
  /** Epoch ms of the token_count event that carried the limits. */
  capturedAt: number;
  limits: RolloutRateLimits;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** Directory entries sorted newest first; rollout directories and names sort by date. */
async function newestFirst(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort((a, b) => b.localeCompare(a));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

/** Rollout files of one day directory, newest first. */
async function rolloutsOfDay(dayDir: string): Promise<string[]> {
  const names = await newestFirst(dayDir);
  return names
    .filter((name) => name.startsWith("rollout-") && name.endsWith(".jsonl"))
    .map((name) => join(dayDir, name));
}

/** The newest `limit` rollout files, by the date in their directory and file names. */
async function newestRollouts(codexHome: string, limit: number): Promise<string[]> {
  const root = join(codexHome, "sessions");
  const found: string[] = [];
  for (const year of await newestFirst(root)) {
    for (const month of await newestFirst(join(root, year))) {
      for (const day of await newestFirst(join(root, year, month))) {
        found.push(...(await rolloutsOfDay(join(root, year, month, day))));
        if (found.length >= limit) return found.slice(0, limit);
      }
    }
  }
  return found;
}

async function readTail(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, ROLLOUT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

/** The last token_count of a rollout that carries a window, from its tail. */
async function lastSnapshot(path: string): Promise<RolloutSnapshot | null> {
  const lines = (await readTail(path)).split("\n");
  let fallback: RolloutSnapshot | null = null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (!line.includes('"token_count"') || !line.includes('"rate_limits"')) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      // The tail starts mid-line, so the first line of the read is usually cut off.
      continue;
    }
    const event = eventSchema.safeParse(json);
    const limits = event.success ? event.data.payload.rate_limits : null;
    if (!event.success || !limits || (!limits.primary && !limits.secondary)) continue;
    const capturedAt = Date.parse(event.data.timestamp);
    if (!Number.isFinite(capturedAt)) continue;
    const snapshot = { capturedAt, limits };
    if (limits.limit_id === RATE_LIMITS_BUCKET) return snapshot;
    // Other buckets (a model-specific limit) are only used when the main one never appears.
    fallback ??= snapshot;
  }
  return fallback;
}

/**
 * The newest rate-limit snapshot in the Codex home's rollouts, or null when there is none. A
 * missing sessions directory is "none"; any other read failure throws so the caller reports it.
 */
export async function newestRolloutSnapshot(codexHome: string): Promise<RolloutSnapshot | null> {
  let newest: RolloutSnapshot | null = null;
  for (const path of await newestRollouts(codexHome, MAX_ROLLOUTS_TRIED)) {
    let snapshot: RolloutSnapshot | null;
    try {
      snapshot = await lastSnapshot(path);
    } catch (error) {
      // A rollout deleted between listing and reading is not a failure.
      if (isMissing(error)) continue;
      throw error;
    }
    if (snapshot && (!newest || snapshot.capturedAt > newest.capturedAt)) newest = snapshot;
  }
  return newest;
}
