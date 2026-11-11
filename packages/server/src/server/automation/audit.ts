import { appendFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import {
  AutomationAuditEntrySchema,
  type AutomationAuditEntry,
} from "@pimi/protocol/automation/types";

const AUDIT_ROTATE_BYTES = 1024 * 1024;

// Append-only record of what happened to each automation and who did it. Entries carry ids,
// actions and short details only: never prompts or agent output.
export class AutomationAuditLog {
  private readonly dir: string;
  private readonly logger: Logger;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: { dir: string; logger: Logger }) {
    this.dir = options.dir;
    this.logger = options.logger;
  }

  private get currentPath(): string {
    return join(this.dir, "audit.jsonl");
  }

  private get rotatedPath(): string {
    return join(this.dir, "audit.1.jsonl");
  }

  private async write(line: string): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await this.rotateIfFull();
    await appendFile(this.currentPath, line, { mode: 0o600 });
  }

  append(entry: Omit<AutomationAuditEntry, "at">): Promise<void> {
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`;
    const next = this.chain
      .catch(() => undefined)
      .then(() => this.write(line))
      .catch((error) => {
        this.logger.error({ err: error, automationId: entry.automationId }, "Audit append failed");
      });
    this.chain = next;
    return next;
  }

  async readForAutomation(automationId: string, limit: number): Promise<AutomationAuditEntry[]> {
    await this.chain.catch(() => undefined);
    const entries: AutomationAuditEntry[] = [];
    for (const path of [this.rotatedPath, this.currentPath]) {
      let content: string;
      try {
        content = await readFile(path, "utf-8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw error;
      }
      for (const line of content.split("\n")) {
        if (!line.trim()) {
          continue;
        }
        let json: unknown;
        try {
          json = JSON.parse(line);
        } catch {
          continue;
        }
        const parsed = AutomationAuditEntrySchema.safeParse(json);
        if (parsed.success && parsed.data.automationId === automationId) {
          entries.push(parsed.data);
        }
      }
    }
    return entries.slice(-limit);
  }

  private async rotateIfFull(): Promise<void> {
    try {
      const info = await stat(this.currentPath);
      if (info.size >= AUDIT_ROTATE_BYTES) {
        await rename(this.currentPath, this.rotatedPath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}
