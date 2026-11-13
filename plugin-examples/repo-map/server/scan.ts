import { lstat } from "node:fs/promises";
import path from "node:path";
import { execCommand } from "@pimi/plugin/server";
import type { PluginServerStorage } from "@pimi/plugin/server";
import { MAX_FILES, type Scan } from "../shared/contracts";

const STAT_CONCURRENCY = 64;
const COMMITS_SCANNED = 500;
const GIT_OUTPUT_LIMIT = 256 * 1024 * 1024;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execCommand("git", ["-c", "core.quotepath=false", ...args], {
    cwd,
    maxBuffer: GIT_OUTPUT_LIMIT,
  });
  return stdout;
}

async function readHead(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ["rev-parse", "HEAD"])).trim() || null;
  } catch {
    // A repository with no commits has no HEAD; its files still list.
    return null;
  }
}

/** Newest commit time per path across the last commits, parsed from `git log --name-only`. */
async function readCommitTimes(cwd: string): Promise<Record<string, number>> {
  const output = await git(cwd, [
    "log",
    "-n",
    String(COMMITS_SCANNED),
    "--name-only",
    "--format=%x00%ct",
  ]);
  const times: Record<string, number> = {};
  for (const chunk of output.split("\0")) {
    const [stamp, ...names] = chunk.split("\n");
    const seconds = Number(stamp);
    if (!Number.isFinite(seconds) || !stamp) continue;
    for (const name of names) {
      if (name && times[name] === undefined) times[name] = seconds;
    }
  }
  return times;
}

/**
 * Commit times only change when HEAD moves, so they are cached by HEAD. File sizes are read every
 * scan: an edit changes the map before it is committed.
 */
async function commitTimesFor(
  cwd: string,
  head: string | null,
  storage: PluginServerStorage,
): Promise<Record<string, number>> {
  if (!head) return {};
  const key = `commit-times:${cwd}`;
  const cached = await storage.get<{ head: string; times: Record<string, number> }>(key);
  if (cached?.head === head) return cached.times;
  const times = await readCommitTimes(cwd);
  await storage.set(key, { head, times });
  return times;
}

async function mapLimit<Item, Result>(
  items: readonly Item[],
  limit: number,
  work: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function scanRepository(cwd: string, storage: PluginServerStorage): Promise<Scan> {
  const listed = (await git(cwd, ["ls-files", "-z"])).split("\0").filter(Boolean);
  const truncated = listed.length > MAX_FILES;
  const paths = truncated ? listed.slice(0, MAX_FILES) : listed;
  const head = await readHead(cwd);
  const [times, sizes] = await Promise.all([
    commitTimesFor(cwd, head, storage),
    mapLimit(paths, STAT_CONCURRENCY, async (file) => {
      try {
        return (await lstat(path.join(cwd, file))).size;
      } catch {
        // Listed by git but deleted in the working tree: nothing to draw.
        return null;
      }
    }),
  ]);
  const files = paths.flatMap((file, index) => {
    const bytes = sizes[index];
    return bytes === null ? [] : [{ path: file, bytes, lastCommitAt: times[file] ?? null }];
  });
  return { files, truncated, total: listed.length, head };
}
