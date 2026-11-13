import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Where each harness keeps its login and settings, and what proves a directory is a real install
 * rather than an unrelated folder that happens to share the name.
 */
const HARNESSES = [
  {
    provider: "claude",
    envKey: "CLAUDE_CONFIG_DIR",
    namePattern: /^\.claude(?:[-_.].+)?$/,
    defaultDirName: ".claude",
    markers: [".credentials.json", "settings.json", "projects"],
  },
  {
    provider: "codex",
    envKey: "CODEX_HOME",
    namePattern: /^\.codex(?:[-_.].+)?$/,
    defaultDirName: ".codex",
    markers: ["auth.json", "config.toml"],
  },
] as const;

export interface DetectedConfigDirectory {
  provider: string;
  envKey: string;
  path: string;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds extra harness installs next to the default one: sibling directories such as
 * `~/.claude-work` or `~/.codex-2` that hold a login or settings. Read-only. Directories a
 * provider already launches with are left out, so each result is an install no chat can use yet.
 */
export async function detectProviderConfigDirectories(input: {
  /** Config directory each provider launches with now, resolved from its environment. */
  inUse: ReadonlyArray<{ envKey: string; path: string }>;
  home?: string;
}): Promise<DetectedConfigDirectory[]> {
  const home = input.home ?? homedir();
  let entries: string[];
  try {
    entries = await readdir(home);
  } catch {
    return [];
  }
  const used = new Set(input.inUse.map((entry) => resolve(entry.path)));
  const found: DetectedConfigDirectory[] = [];
  for (const harness of HARNESSES) {
    used.add(resolve(join(home, harness.defaultDirName)));
    for (const name of entries.filter((entry) => harness.namePattern.test(entry)).sort()) {
      const path = resolve(join(home, name));
      if (used.has(path) || !(await isDirectory(path))) continue;
      const markers = await Promise.all(harness.markers.map((m) => exists(join(path, m))));
      if (markers.some(Boolean)) {
        found.push({ provider: harness.provider, envKey: harness.envKey, path });
      }
    }
  }
  return found;
}
