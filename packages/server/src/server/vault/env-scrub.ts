import { readFile } from "node:fs/promises";
import path from "node:path";
import { readVaultHeader } from "./store.js";

// The environment the daemon launches agents, terminals and commands with starts as the daemon's
// own. Removing a name from the daemon's environment before anything is spawned means it cannot
// reach any child, whether or not that spawn site knows about the vault. An explicit provider
// overlay still wins because overlays are applied on top of whatever remains.

/**
 * Whether the user turned the vault on (`daemon.vault.enabled` in config.json). Read straight from
 * the file so the desktop can ask before the daemon runs; a missing or unreadable file is off.
 */
export async function readVaultEnabled(pimiHome: string): Promise<boolean> {
  try {
    const raw = await readFile(path.join(pimiHome, "config.json"), "utf-8");
    const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
    const daemon = (parsed as { daemon?: { vault?: { enabled?: unknown } } } | null)?.daemon;
    return daemon?.vault?.enabled === true;
  } catch {
    return false;
  }
}

/**
 * Names recorded in the vault header, or none while the vault is off: off means the vault's file is
 * ignored, so nothing is removed from the environment. Readable while the vault is locked.
 */
export async function readEnvScrubNames(pimiHome: string): Promise<string[]> {
  if (!(await readVaultEnabled(pimiHome))) return [];
  return (await readVaultHeader(pimiHome))?.envScrubNames ?? [];
}

function sameName(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toUpperCase() === b.toUpperCase() : a === b;
}

/** A copy of `env` without the named variables. */
export function scrubEnvNames(
  env: Record<string, string | undefined>,
  names: readonly string[],
): Record<string, string | undefined> {
  const copy: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!names.some((name) => sameName(name, key))) copy[key] = value;
  }
  return copy;
}

/** Deletes the named variables from `env` in place and returns the ones that were set. */
export function removeEnvNames(env: NodeJS.ProcessEnv, names: readonly string[]): string[] {
  const removed: string[] = [];
  for (const name of names) {
    if (env[name] !== undefined) removed.push(name);
    delete env[name];
  }
  return removed;
}
