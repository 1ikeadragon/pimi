import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

// Orphaned temp files from writeFileAtomic (a process killed between write and rename) are
// removed after a day; no live write holds one that long.
const STALE_TEMP_MS = 24 * 60 * 60_000;

export interface StaleFile {
  name: string;
  path: string;
  // Temp files are always safe to delete; others belong to a record the caller must check.
  temp: boolean;
}

// Files in `directory` whose last write is older than `maxAgeMs`, plus orphaned temp files.
// A missing directory is empty. Files that vanish mid-scan are skipped.
export async function listStaleFiles(
  directory: string,
  maxAgeMs: number,
  now: number,
): Promise<StaleFile[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const stale: StaleFile[] = [];
  for (const name of names) {
    const temp = name.endsWith(".tmp");
    if (!temp && !name.endsWith(".json") && !name.endsWith(".claim")) continue;
    const path = join(directory, name);
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(path)).mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (now - mtimeMs > (temp ? STALE_TEMP_MS : maxAgeMs)) stale.push({ name, path, temp });
  }
  return stale;
}
