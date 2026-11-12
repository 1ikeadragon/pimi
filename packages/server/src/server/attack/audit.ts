import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import { AttackAuditEntrySchema, type AttackAuditEntry } from "@pimi/protocol/attack/types";

const AUDIT_READ_LIMIT = 200;

// Append-only record of what an Attack run did: starts, budget stops, navigation refusals and
// finding ids. Entries carry ids, actions and short details only: never prompts, URLs with
// paths, evidence or agent output. One file per run.
export class AttackAuditLog {
  private readonly path: string;
  private readonly dir: string;
  private readonly logger: Logger;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: { dir: string; logger: Logger }) {
    this.dir = options.dir;
    this.path = join(options.dir, "audit.jsonl");
    this.logger = options.logger;
  }

  append(entry: Omit<AttackAuditEntry, "at">): Promise<void> {
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`;
    const next = this.chain
      .catch(() => undefined)
      .then(() => this.write(line))
      .catch((error) => {
        this.logger.error({ err: error, runId: entry.runId }, "Attack audit append failed");
      });
    this.chain = next;
    return next;
  }

  private async write(line: string): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await appendFile(this.path, line, { mode: 0o600 });
  }

  async read(limit = AUDIT_READ_LIMIT): Promise<AttackAuditEntry[]> {
    await this.chain.catch(() => undefined);
    let content: string;
    try {
      content = await readFile(this.path, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const entries: AttackAuditEntry[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = AttackAuditEntrySchema.safeParse(JSON.parse(line));
        if (parsed.success) entries.push(parsed.data);
      } catch {
        // A torn last line from a crash is skipped.
      }
    }
    return entries.slice(-limit);
  }
}
