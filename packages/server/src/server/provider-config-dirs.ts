import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ProviderOverride } from "@pimi/protocol/provider-config";

/**
 * Where each harness keeps its login, and what proves a directory holds one. The marker files are
 * only checked for existence or a non-secret field; their tokens are never read.
 */
const HARNESSES = [
  {
    provider: "claude",
    label: "Claude",
    envKey: "CLAUDE_CONFIG_DIR",
    namePattern: /^\.claude(?:[-_.].+)?$/,
    defaultDirName: ".claude",
  },
  {
    provider: "codex",
    label: "Codex",
    envKey: "CODEX_HOME",
    namePattern: /^\.codex(?:[-_.].+)?$/,
    defaultDirName: ".codex",
  },
] as const;

type Harness = (typeof HARNESSES)[number];

export interface DetectedInstall {
  provider: Harness["provider"];
  envKey: Harness["envKey"];
  path: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isSignedIn(harness: Harness, dir: string): Promise<boolean> {
  if (harness.provider === "codex") return exists(join(dir, "auth.json"));
  // Claude Code on macOS keeps the token in the Keychain, but records the account it is signed in
  // as in `.claude.json` inside the config directory.
  if (await exists(join(dir, ".credentials.json"))) return true;
  try {
    const state: unknown = JSON.parse(await readFile(join(dir, ".claude.json"), "utf8"));
    const account = (state as { oauthAccount?: unknown } | null)?.oauthAccount;
    return typeof account === "object" && account !== null;
  } catch {
    return false;
  }
}

/**
 * Signed-in harness installs next to the default one: sibling directories of the home directory
 * such as `~/.claude-work` or `~/.codex-2`. Read-only.
 */
export async function detectProviderInstalls(home = homedir()): Promise<DetectedInstall[]> {
  let entries: string[];
  try {
    entries = await readdir(home);
  } catch {
    return [];
  }
  const found: DetectedInstall[] = [];
  for (const harness of HARNESSES) {
    for (const name of entries.filter((entry) => harness.namePattern.test(entry)).sort()) {
      if (name === harness.defaultDirName) continue;
      const path = resolve(join(home, name));
      try {
        if (!(await stat(path)).isDirectory()) continue;
      } catch {
        continue;
      }
      if (await isSignedIn(harness, path)) {
        found.push({ provider: harness.provider, envKey: harness.envKey, path });
      }
    }
  }
  return found;
}

/**
 * The provider each detected install registers as. The id comes from the directory name, so it is
 * the same on every scan and across restarts: `~/.claude-work` is always `claude-work`.
 * Installs whose directory a provider already launches with, or whose id is taken, are skipped.
 */
export function buildDetectedProviderOverrides(input: {
  installs: readonly DetectedInstall[];
  takenIds: ReadonlySet<string>;
  usedDirectories: ReadonlySet<string>;
}): Record<string, ProviderOverride> {
  const overrides: Record<string, ProviderOverride> = {};
  for (const install of input.installs) {
    const id = basename(install.path)
      .toLowerCase()
      .replace(/^\./, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+$/, "");
    if (!id || input.takenIds.has(id) || input.usedDirectories.has(install.path)) continue;
    const harness = HARNESSES.find((candidate) => candidate.provider === install.provider);
    const suffix = id.slice(install.provider.length).replace(/^-/, "");
    overrides[id] = {
      extends: install.provider,
      label: suffix ? `${harness?.label} ${suffix}` : (harness?.label ?? id),
      description: `Signed in at ${install.path}`,
      env: { [install.envKey]: install.path },
    };
  }
  return overrides;
}
