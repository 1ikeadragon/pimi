import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { JsonValue } from "@pimi/protocol/agent-types";
import type { PluginServerStorage } from "@pimi/plugin/server";

const entrySchema = z.object({ key: z.string(), value: z.json() });

const MAX_KEY_LENGTH = 256;

function entryFile(directory: string, key: string): string {
  return path.join(directory, `${createHash("sha256").update(key).digest("hex")}.json`);
}

function assertKey(key: string): void {
  if (!key || key.length > MAX_KEY_LENGTH) {
    throw new Error(`Storage keys must be 1 to ${MAX_KEY_LENGTH} characters`);
  }
}

/**
 * A plugin's JSON key-value storage: one file per key under `<dataDirectory>/storage`, so a write
 * replaces one small file and never rewrites its neighbors. Writes are atomic (temp file, rename).
 * One instance per plugin process; the subprocess is the only writer.
 */
export class PluginDataStorage implements PluginServerStorage {
  private readonly directory: string;

  constructor(dataDirectory: string) {
    this.directory = path.join(dataDirectory, "storage");
  }

  async get<Value extends JsonValue = JsonValue>(key: string): Promise<Value | undefined> {
    assertKey(key);
    let raw: string;
    try {
      raw = await readFile(entryFile(this.directory, key), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    return entrySchema.parse(JSON.parse(raw)).value as Value;
  }

  async set(key: string, value: JsonValue): Promise<void> {
    assertKey(key);
    const serialized = JSON.stringify({ key, value });
    if (serialized === undefined) throw new Error("Storage values must be JSON");
    await mkdir(this.directory, { recursive: true });
    const target = entryFile(this.directory, key);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialized, "utf8");
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    assertKey(key);
    await rm(entryFile(this.directory, key), { force: true });
  }

  async keys(prefix = ""): Promise<readonly string[]> {
    let files: string[];
    try {
      files = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const keys: string[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const entry = entrySchema.safeParse(
        JSON.parse(await readFile(path.join(this.directory, file), "utf8")),
      );
      if (entry.success && entry.data.key.startsWith(prefix)) keys.push(entry.data.key);
    }
    return keys.sort();
  }
}
