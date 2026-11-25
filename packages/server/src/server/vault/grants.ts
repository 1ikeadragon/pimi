import path from "node:path";
import type { VaultGrantBinding } from "@pimi/protocol/vault/types";
import type { VaultGrantRecord } from "./store.js";

// Executables that run code taken from the directory they are started in (package scripts,
// Makefiles, build files, interpreters given a project file). A grant for one of these lets any
// repository the agent can write to run its own code with the secret in its environment, so the
// UI warns. Compared on the basename of the symlink-resolved path, without a Windows extension.
// The list is the set of tools Pimi's own agents most often invoke; it is a warning aid, not a
// boundary: an executable not named here can still run project code.
const PROJECT_CODE_RUNNERS: ReadonlySet<string> = new Set([
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "bunx",
  "node",
  "deno",
  "make",
  "cmake",
  "just",
  "python",
  "python3",
  "pip",
  "uv",
  "ruby",
  "bundle",
  "rake",
  "perl",
  "php",
  "sh",
  "bash",
  "zsh",
  "fish",
  "cargo",
  "go",
  "gradle",
  "mvn",
  "terraform",
  "tofu",
  "docker",
  "docker-compose",
  "pytest",
  "jest",
  "vitest",
]);

export function runsProjectCode(executable: string): boolean {
  const base = path
    .basename(executable)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat)$/, "");
  return PROJECT_CODE_RUNNERS.has(base) || /^python\d+(\.\d+)*$/.test(base);
}

/** Whether `child` is `parent` or lies below it. */
export function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export interface RunShape {
  /** Symlink-resolved absolute path. */
  executable: string;
  /** Arguments after the executable. */
  args: readonly string[];
  projectId: string | null;
  secrets: readonly string[];
}

function startsWith(args: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= args.length && prefix.every((part, index) => args[index] === part);
}

/**
 * The most specific grant covering the run: same executable, arguments that begin with the
 * grant's prefix, a project the grant allows, and every requested secret bound by the grant.
 * Matching is exact string equality on argv elements: no globbing, no shell parsing.
 */
export function matchGrant(
  grants: readonly VaultGrantRecord[],
  run: RunShape,
): VaultGrantRecord | null {
  let best: VaultGrantRecord | null = null;
  for (const grant of grants) {
    if (grant.executable !== run.executable) continue;
    if (!startsWith(run.args, grant.argvPrefix)) continue;
    if (grant.projectId !== null && grant.projectId !== run.projectId) continue;
    const bound = new Set(grant.bindings.map((binding) => binding.secret));
    if (!run.secrets.every((name) => bound.has(name))) continue;
    if (best === null || grant.argvPrefix.length > best.argvPrefix.length) best = grant;
  }
  return best;
}

/** The bindings a granted run injects: the grant's binding for each requested secret. */
export function bindingsForRun(
  grant: VaultGrantRecord,
  secrets: readonly string[],
): VaultGrantBinding[] {
  return secrets.map((name) => {
    const binding = grant.bindings.find((candidate) => candidate.secret === name);
    if (!binding) throw new Error(`Grant ${grant.id} has no binding for ${name}`);
    return binding;
  });
}

/** Identifies a run for approval tickets: the same call repeated after a timeout maps to one request. */
export function runKey(run: {
  argv: readonly string[];
  cwd: string;
  agentId: string | null;
  secrets: readonly string[];
}): string {
  return JSON.stringify([run.agentId, run.cwd, run.argv, [...run.secrets].sort()]);
}
