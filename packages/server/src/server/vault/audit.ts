import { appendFile, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { VaultAuditEntrySchema, type VaultAuditEntry } from "@pimi/protocol/vault/types";
import { ensurePrivateDirectory, writePrivateFileAtomic } from "../private-files.js";
import { vaultDirectory } from "./store.js";

// Append-only record of who used or changed what. Readable without unlocking: it holds secret
// names, executables and exit codes, never a value (callers redact `detail` before appending).

const AUDIT_FILE_NAME = "audit.jsonl";

// About 150 bytes per entry, so 1 MiB keeps several thousand runs. On overflow the oldest half is
// dropped, which keeps the rewrite rare instead of every append.
export const AUDIT_MAX_BYTES = 1024 * 1024;

export const AUDIT_LIST_MAX_ENTRIES = 500;

export class VaultAudit {
  private readonly filePath: string;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(pimiHome: string) {
    this.filePath = path.join(vaultDirectory(pimiHome), AUDIT_FILE_NAME);
  }

  append(entry: VaultAuditEntry): Promise<void> {
    const write = this.tail.then(() => this.write(entry));
    this.tail = write.catch(() => undefined);
    return write;
  }

  async list(limit: number): Promise<VaultAuditEntry[]> {
    const lines = await this.readLines();
    const entries: VaultAuditEntry[] = [];
    for (const line of lines.slice(-Math.min(limit, AUDIT_LIST_MAX_ENTRIES)).toReversed()) {
      entries.push(VaultAuditEntrySchema.parse(JSON.parse(line)));
    }
    return entries;
  }

  private async write(entry: VaultAuditEntry): Promise<void> {
    ensurePrivateDirectory(path.dirname(this.filePath));
    const line = `${JSON.stringify(VaultAuditEntrySchema.parse(entry))}\n`;
    await appendFile(this.filePath, line, { mode: 0o600 });
    const { size } = await stat(this.filePath);
    if (size > AUDIT_MAX_BYTES) {
      const lines = await this.readLines();
      const kept = lines.slice(Math.floor(lines.length / 2));
      await writePrivateFileAtomic(this.filePath, `${kept.join("\n")}\n`);
    }
  }

  private async readLines(): Promise<string[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    return raw.split("\n").filter((line) => line.length > 0);
  }
}
