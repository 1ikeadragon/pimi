import { readVaultHeader } from "./store.js";

// The environment the daemon launches agents, terminals and commands with starts as the daemon's
// own. Removing a name from the daemon's environment before anything is spawned means it cannot
// reach any child, whether or not that spawn site knows about the vault. An explicit provider
// overlay still wins because overlays are applied on top of whatever remains.

/** Names recorded in the vault header. Readable while the vault is locked. */
export async function readEnvScrubNames(pimiHome: string): Promise<string[]> {
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
