import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyPackagePolicy,
  type PackagePolicy,
  type PackagePolicyResult,
} from "@pimi/protocol/package-runner-policy";
import { ProviderOverrideSchema } from "@pimi/protocol/provider-config";
import type { PackageRunEntry } from "@pimi/protocol/messages";

const KNOWN_RUNNERS = new Set(["npx", "uvx", "bunx", "pnpm"]);

export interface McpPackageSource {
  name: string;
  argv: string[];
}

// npm's cache location without spawning npm: the env override, else the platform default. A cache
// location set only in an .npmrc is not seen; absence here only means no inspected cache match.
function npmCacheDir(): string {
  const fromEnv = process.env.npm_config_cache ?? process.env.NPM_CONFIG_CACHE;
  if (fromEnv) return fromEnv;
  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
      "npm-cache",
    );
  }
  return path.join(os.homedir(), ".npm");
}

interface NpxInstall {
  version: string;
  installedAtMs: number;
}

async function readJson(file: string, unreadable: () => void): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    unreadable();
    return null;
  }
}

// npx installs each package set into `_npx/<hash>/` and records the requested specs in that
// directory's package.json under `_npx.packages`. Matching on that list, not on the hash, keeps
// this independent of how npm derives the directory name. When several directories match, the
// most recently modified readable metadata is shown as one observed cached copy. This does not
// establish which copy is running, whether it was ever launched, or an installation date.
interface NpxCacheIndex {
  installs: Map<string, NpxInstall>;
  readable: boolean;
}

async function indexNpxCache(): Promise<NpxCacheIndex> {
  const root = path.join(npmCacheDir(), "_npx");
  const bySpec = new Map<string, NpxInstall>();
  let readable = true;
  let dirs: string[];
  try {
    dirs = await fs.readdir(root);
  } catch (error) {
    return {
      installs: bySpec,
      readable: (error as NodeJS.ErrnoException).code === "ENOENT",
    };
  }
  const unreadable = () => {
    readable = false;
  };
  let nextDirectory = 0;
  // Inspect every entry without opening an unbounded number of files at once.
  await Promise.all(
    Array.from({ length: Math.min(8, dirs.length) }, async () => {
      while (nextDirectory < dirs.length) {
        const dir = dirs[nextDirectory++];
        await inspectDirectory(dir);
      }
    }),
  );
  return { installs: bySpec, readable };

  async function inspectDirectory(dir: string): Promise<void> {
    const manifest = (await readJson(path.join(root, dir, "package.json"), unreadable)) as {
      _npx?: { packages?: unknown };
    } | null;
    const packages = manifest?._npx?.packages;
    if (!Array.isArray(packages) || packages.length !== 1 || typeof packages[0] !== "string") {
      return;
    }
    const spec = packages[0];
    const name = specName(spec);
    const modules = path.join(root, dir, "node_modules");
    const installed = (await readJson(path.join(modules, name, "package.json"), unreadable)) as {
      version?: unknown;
    } | null;
    if (typeof installed?.version !== "string") return;
    let installedAtMs: number;
    try {
      installedAtMs = (await fs.stat(path.join(modules, ".package-lock.json"))).mtimeMs;
    } catch {
      unreadable();
      return;
    }
    const existing = bySpec.get(spec);
    if (!existing || existing.installedAtMs < installedAtMs) {
      bySpec.set(spec, { version: installed.version, installedAtMs });
    }
  }
}

function specName(spec: string): string {
  const at = spec.indexOf("@", 1);
  return at === -1 ? spec : spec.slice(0, at);
}

// Only pinned mode defers to the command: an exact version, or a date bound already in it.
function reasonFor(
  result: PackagePolicyResult,
  configured: readonly string[],
  policy: PackagePolicy,
): PackageRunEntry["reason"] {
  if (!result.managed) return "unmanaged";
  if (policy.mode !== "pinned") return "policy";
  if (result.pinnedVersion) return "exactVersion";
  const ownDateFlag = configured.some((arg) =>
    ["--before=", "--min-release-age=", "--exclude-newer="].some((flag) => arg.startsWith(flag)),
  );
  return ownDateFlag ? "commandDateFlag" : "policy";
}

function buildEntry(
  input: { id: string; kind: PackageRunEntry["kind"]; label: string; argv: string[] },
  policy: PackagePolicy,
  now: number,
  npx: NpxCacheIndex,
): PackageRunEntry {
  const result = applyPackagePolicy(input.argv, policy, now);
  const runner = input.argv[0] ?? "";
  const canObserve = result.managed && result.runner === "npx";
  const installed = canObserve && result.spec ? (npx.installs.get(result.spec) ?? null) : null;
  const installedKnown = canObserve && (npx.readable || installed !== null);
  return {
    id: input.id,
    kind: input.kind,
    label: input.label,
    runner,
    managed: result.managed,
    name: result.name,
    requestedSpec: result.requestedSpec,
    spec: result.spec,
    pinnedVersion: result.pinnedVersion,
    cutoff: result.cutoff,
    reason: reasonFor(result, input.argv, policy),
    configuredCommand: input.argv,
    effectiveCommand: result.argv,
    installed,
    installedKnown,
  };
}

/**
 * Every package Pimi runs through a package runner: custom ACP providers from the daemon config
 * and the stdio MCP servers it hands to agents. The policy is applied here, once, so every client
 * shows the same answer. Reads the local npx cache; makes no network calls.
 */
export async function collectPackageRuns(input: {
  providers: Record<string, unknown>;
  mcpServers: readonly McpPackageSource[];
  policy: PackagePolicy;
  now: number;
}): Promise<PackageRunEntry[]> {
  const npx = await indexNpxCache();
  const entries: PackageRunEntry[] = [];
  for (const [providerId, raw] of Object.entries(input.providers)) {
    const parsed = ProviderOverrideSchema.safeParse(raw);
    if (!parsed.success) continue;
    const { command, extends: base, enabled, label } = parsed.data;
    // Only ACP providers go through the policy; other overrides spawn their command untouched.
    if (base !== "acp" || enabled === false || !command || command.length === 0) continue;
    if (!KNOWN_RUNNERS.has(command[0])) continue;
    entries.push(
      buildEntry(
        { id: `acp:${providerId}`, kind: "acp", label: label ?? providerId, argv: command },
        input.policy,
        input.now,
        npx,
      ),
    );
  }
  const seen = new Set<string>();
  for (const server of input.mcpServers) {
    if (!KNOWN_RUNNERS.has(server.argv[0])) continue;
    const id = `mcp:${server.name}:${server.argv.join(" ")}`;
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push(
      buildEntry(
        { id, kind: "mcp", label: server.name, argv: server.argv },
        input.policy,
        input.now,
        npx,
      ),
    );
  }
  return entries;
}
