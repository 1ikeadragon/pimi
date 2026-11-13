import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { AgentSlashCommand } from "./agent-sdk-types.js";

/** How long cached slash commands are served without a background refresh. */
const FRESH_MS = 60_000;

/**
 * Directories whose contents decide a provider's slash commands and skills. Adding or removing
 * an entry changes the directory's mtime, which invalidates the cache. Plugin-provided and
 * MCP-provided commands are not covered (`.claude/plugins` changes whenever a provider
 * process starts, so it cannot be a key); the 60 s refresh picks those up.
 */
const COMMAND_DIRS = [
  ".claude/commands",
  ".claude/skills",
  ".codex/prompts",
  ".codex/skills",
  ".agents/skills",
  ".opencode/command",
  ".opencode/skills",
];

async function fingerprint(cwd: string): Promise<string> {
  const roots = [cwd, homedir()];
  const mtimes = await Promise.all(
    roots.flatMap((root) =>
      COMMAND_DIRS.map(async (dir) => {
        try {
          return (await stat(path.join(root, dir))).mtimeMs;
        } catch {
          return 0;
        }
      }),
    ),
  );
  return mtimes.join(",");
}

interface Entry {
  commands: AgentSlashCommand[];
  at: number;
  fingerprint: string;
}

/**
 * Slash commands last read from a live session, per provider and folder, shared by every chat
 * there. A read in flight is shared too, so a request arriving during a chat's load waits for
 * the one read instead of starting another provider process.
 */
export class SlashCommandsCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Promise<AgentSlashCommand[]>>();

  private key(provider: string, cwd: string): string {
    return `${provider}\0${cwd}`;
  }

  /** Cached commands, or null when none exist or the command directories changed since. */
  async get(
    provider: string,
    cwd: string,
  ): Promise<{ commands: AgentSlashCommand[]; stale: boolean } | null> {
    const entry = this.entries.get(this.key(provider, cwd));
    if (!entry) return null;
    if (entry.fingerprint !== (await fingerprint(cwd))) return null;
    return { commands: entry.commands, stale: Date.now() - entry.at > FRESH_MS };
  }

  /** Read through `read`, sharing a read already in flight, and remember the result. */
  read(
    provider: string,
    cwd: string,
    read: () => Promise<AgentSlashCommand[]>,
  ): Promise<AgentSlashCommand[]> {
    const key = this.key(provider, cwd);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    // The fingerprint is taken before the read, so a directory change during the read
    // invalidates the result instead of being masked by it.
    const run = (async () => {
      const before = await fingerprint(cwd);
      const commands = await read();
      this.entries.set(key, { commands, at: Date.now(), fingerprint: before });
      return commands;
    })();
    this.inFlight.set(key, run);
    const clear = () => {
      if (this.inFlight.get(key) === run) this.inFlight.delete(key);
    };
    run.then(clear, clear);
    return run;
  }
}
