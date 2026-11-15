/**
 * Daemon registration for the Node relay: binds each serverId to the first
 * daemon token that registers it (trust on first use).
 *
 * Without this, anyone who learns a serverId could open `role=server` sockets
 * and keep displacing the real daemon. Confidentiality never depended on it
 * (the channel is end-to-end Noise), but availability did.
 *
 * The daemon sends a random 256-bit token as `Authorization: Bearer <token>`.
 * The relay stores only SHA-256(token) per serverId, compares in constant time,
 * and persists the map so a relay restart opens no race window. Entries a
 * daemon has not used for {@link RETENTION_DAYS} are dropped on load; a daemon
 * locked out after that can reset its pairing (new serverId).
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RETENTION_DAYS = 180;
const DAY_MS = 86_400_000;
const SAVE_DEBOUNCE_MS = 5_000;

export type ServerAuthResult = "ok" | "missing_token" | "wrong_token" | "registry_full";

interface Entry {
  /** hex SHA-256 of the token */
  h: string;
  /** last day (epoch days) a socket authenticated */
  d: number;
}

interface StoredRegistry {
  v: 1;
  entries: Record<string, Entry>;
}

export interface ServerRegistry {
  authorize(serverId: string, authorization: string | undefined): ServerAuthResult;
  isRegistered(serverId: string): boolean;
  flush(): void;
  size(): number;
}

export function createServerRegistry(options: {
  /** JSON file for persistence; null keeps the map in memory only. */
  filePath: string | null;
  maxEntries: number;
  log: (event: string, fields?: Record<string, string | number | boolean>) => void;
  now?: () => number;
}): ServerRegistry {
  const now = options.now ?? Date.now;
  const entries = load(options.filePath, Math.floor(now() / DAY_MS), options.log);
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  function save(): void {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!options.filePath) return;
    const stored: StoredRegistry = { v: 1, entries: Object.fromEntries(entries) };
    const tmp = `${options.filePath}.tmp`;
    try {
      mkdirSync(path.dirname(options.filePath), { recursive: true, mode: 0o700 });
      writeFileSync(tmp, JSON.stringify(stored), { mode: 0o600 });
      renameSync(tmp, options.filePath);
    } catch (error) {
      options.log("registry_save_failed", {
        reason: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  function scheduleSave(): void {
    if (saveTimer || !options.filePath) return;
    saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS);
    saveTimer.unref?.();
  }

  return {
    authorize(serverId, authorization) {
      const token = parseBearer(authorization);
      if (!token) return "missing_token";
      const digest = sha256(token);
      const today = Math.floor(now() / DAY_MS);
      const existing = entries.get(serverId);
      if (!existing) {
        if (entries.size >= options.maxEntries) return "registry_full";
        entries.set(serverId, { h: digest.toString("hex"), d: today });
        save(); // a new binding is durable before the daemon is admitted
        return "ok";
      }
      if (!timingSafeEqual(Buffer.from(existing.h, "hex"), digest)) return "wrong_token";
      if (existing.d !== today) {
        existing.d = today;
        scheduleSave();
      }
      return "ok";
    },
    isRegistered: (serverId) => entries.has(serverId),
    flush: save,
    size: () => entries.size,
  };
}

function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer ([^\s]+)$/.exec(header.trim());
  const token = match?.[1];
  return token && TOKEN_PATTERN.test(token) ? token : null;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function load(
  filePath: string | null,
  today: number,
  log: (event: string, fields?: Record<string, string | number | boolean>) => void,
): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  if (!filePath) return entries;
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return entries;
    // Unreadable state must not silently reopen every serverId to squatting.
    throw error;
  }
  const parsed = JSON.parse(raw) as StoredRegistry;
  if (parsed?.v !== 1 || typeof parsed.entries !== "object" || parsed.entries === null) {
    throw new Error("server registry has an unknown format");
  }
  let expired = 0;
  for (const [serverId, entry] of Object.entries(parsed.entries)) {
    if (typeof entry?.h !== "string" || !/^[0-9a-f]{64}$/.test(entry.h)) continue;
    if (typeof entry.d !== "number" || today - entry.d > RETENTION_DAYS) {
      expired += 1;
      continue;
    }
    entries.set(serverId, { h: entry.h, d: entry.d });
  }
  log("registry_loaded", { entries: entries.size, expired });
  return entries;
}
