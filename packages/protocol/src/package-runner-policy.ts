import { z } from "zod";

// Supply-chain policy for package runners (npx, uvx). npm and uv both resolve "newest version
// published before T" natively, so the policy only rewrites argv: the version spec and one date
// flag. Nothing here touches the network or a shell.

export const PACKAGE_POLICY_MIN_AGE_DAYS_MIN = 1;
export const PACKAGE_POLICY_MIN_AGE_DAYS_MAX = 90;
export const PACKAGE_POLICY_MIN_AGE_DAYS_DEFAULT = 7;

export const PackagePolicyModeSchema = z.enum(["pinned", "minAge", "latest"]);
export type PackagePolicyMode = z.infer<typeof PackagePolicyModeSchema>;

export const PackagePolicySchema = z.object({
  mode: PackagePolicyModeSchema,
  minAgeDays: z
    .number()
    .int()
    .min(PACKAGE_POLICY_MIN_AGE_DAYS_MIN)
    .max(PACKAGE_POLICY_MIN_AGE_DAYS_MAX),
});
export type PackagePolicy = z.infer<typeof PackagePolicySchema>;

export const DEFAULT_PACKAGE_POLICY: PackagePolicy = {
  mode: "pinned",
  minAgeDays: PACKAGE_POLICY_MIN_AGE_DAYS_DEFAULT,
};

export type PackageRunner = "npx" | "uvx";

export interface PackagePolicyResult {
  argv: string[];
  // True when argv is an npx or uvx command this module understands. False means argv is
  // returned untouched because the runner or one of its flags is not recognised.
  managed: boolean;
  runner: PackageRunner | null;
  name: string | null;
  // The package spec token as written in the command, and as it appears in the returned argv.
  // They differ when the policy strips a version or a range.
  requestedSpec: string | null;
  spec: string | null;
  // The exact version the returned argv runs, or null when the version is resolved by date.
  pinnedVersion: string | null;
  // ISO instant of the date bound in the returned argv, or null when there is none.
  cutoff: string | null;
}

// Same shape as the plugin npm source pattern in
// packages/server/src/server/plugins/managed-source/npm.ts.
const NPM_SPEC_PATTERN =
  /^(?<name>(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:@(?<spec>[^:@/\\]+))?$/;
const NPM_EXACT_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PYPI_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PYPI_VERSION = /^[0-9][A-Za-z0-9.!+_-]*$/;
const PYPI_RANGE = /^(?:[<>=!~]=?|===)[A-Za-z0-9.!+*_-]+(?:,(?:[<>=!~]=?|===)[A-Za-z0-9.!+*_-]+)*$/;
const PYPI_FROM = /^(?<name>[A-Za-z0-9][A-Za-z0-9._-]*)(?<rest>[<>=!~,][^\s]*)?$/;

const DAY_MS = 86_400_000;

type Version = { kind: "none" } | { kind: "exact"; version: string } | { kind: "unpinned" };
interface ParsedSpec {
  name: string;
  version: Version;
  // The spec token for the stripped (bare name) form.
  bare: string;
}

function parseNpmSpec(token: string): ParsedSpec | null {
  const groups = NPM_SPEC_PATTERN.exec(token)?.groups;
  if (!groups?.name) return null;
  const spec = groups.spec;
  let version: Version = { kind: "unpinned" };
  if (spec === undefined) version = { kind: "none" };
  else if (NPM_EXACT_VERSION.test(spec)) version = { kind: "exact", version: spec };
  return { name: groups.name, version, bare: groups.name };
}

// `uvx name`, `uvx name@1.2.3`, `uvx name@latest`.
function parseUvxPositional(token: string): ParsedSpec | null {
  const at = token.indexOf("@");
  const name = at === -1 ? token : token.slice(0, at);
  if (!PYPI_NAME.test(name)) return null;
  if (at === -1) return { name, version: { kind: "none" }, bare: name };
  const spec = token.slice(at + 1);
  if (spec === "latest") return { name, version: { kind: "unpinned" }, bare: name };
  if (PYPI_VERSION.test(spec))
    return { name, version: { kind: "exact", version: spec }, bare: name };
  return null;
}

// `--from name`, `--from name==1.2.3`, `--from "name>=1,<2"`.
function parseUvxFrom(token: string): ParsedSpec | null {
  const groups = PYPI_FROM.exec(token)?.groups;
  if (!groups?.name) return null;
  const rest = groups.rest;
  if (rest === undefined)
    return { name: groups.name, version: { kind: "none" }, bare: groups.name };
  if (rest.startsWith("==") && PYPI_VERSION.test(rest.slice(2))) {
    return {
      name: groups.name,
      version: { kind: "exact", version: rest.slice(2) },
      bare: groups.name,
    };
  }
  if (PYPI_RANGE.test(rest)) {
    return { name: groups.name, version: { kind: "unpinned" }, bare: groups.name };
  }
  return null;
}

interface ParsedRunner {
  runner: PackageRunner;
  spec: ParsedSpec;
  specIndex: number;
  // Index of the existing date flag, or -1.
  dateFlagIndex: number;
}

function parseNpx(argv: readonly string[]): ParsedRunner | null {
  let dateFlagIndex = -1;
  let packageIndex = -1;
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (token === "-p" || token === "--package") {
      if (packageIndex !== -1 || i + 1 >= argv.length) return null;
      packageIndex = i + 1;
      i += 1;
      continue;
    }
    if (token.startsWith("--before=") || token.startsWith("--min-release-age=")) {
      if (dateFlagIndex !== -1) return null;
      dateFlagIndex = i;
      continue;
    }
    if (["-y", "--yes", "-q", "--quiet", "--ignore-scripts"].includes(token)) continue;
    if (token.startsWith("-")) return null;
    // First positional: the package spec, unless -p named it and this is the binary.
    const specIndex = packageIndex !== -1 ? packageIndex : i;
    const spec = parseNpmSpec(argv[specIndex]);
    return spec ? { runner: "npx", spec, specIndex, dateFlagIndex } : null;
  }
  return null;
}

function parseUvx(argv: readonly string[]): ParsedRunner | null {
  let dateFlagIndex = -1;
  let fromIndex = -1;
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--from") {
      if (fromIndex !== -1 || i + 1 >= argv.length) return null;
      fromIndex = i + 1;
      i += 1;
      continue;
    }
    if (token.startsWith("--exclude-newer=")) {
      if (dateFlagIndex !== -1) return null;
      dateFlagIndex = i;
      continue;
    }
    if (token.startsWith("-")) return null;
    if (fromIndex !== -1) {
      const spec = parseUvxFrom(argv[fromIndex]);
      return spec ? { runner: "uvx", spec, specIndex: fromIndex, dateFlagIndex } : null;
    }
    const spec = parseUvxPositional(token);
    return spec ? { runner: "uvx", spec, specIndex: i, dateFlagIndex } : null;
  }
  return null;
}

// npm refuses `--before` whenever any min-release-age is configured, including a project or user
// .npmrc, and no flag or env value cancels that. A `--min-release-age` flag overrides the
// configured value instead, so npx gets the relative bound. uv has no such conflict.
function dateFlag(runner: PackageRunner, iso: string, days: number): string {
  return runner === "npx" ? `--min-release-age=${days}` : `--exclude-newer=${iso}`;
}

function clampDays(days: number): number {
  return Math.min(
    PACKAGE_POLICY_MIN_AGE_DAYS_MAX,
    Math.max(PACKAGE_POLICY_MIN_AGE_DAYS_MIN, Math.round(days)),
  );
}

// The instant an existing date flag allows, for display.
function existingFlagCutoff(flag: string, nowMs: number): string {
  const value = flag.slice(flag.indexOf("=") + 1);
  return flag.startsWith("--min-release-age=") ? cutoffIso(nowMs, Number(value)) : value;
}

function cutoffIso(nowMs: number, days: number): string {
  const bound = new Date(nowMs - clampDays(days) * DAY_MS);
  bound.setUTCHours(0, 0, 0, 0);
  return bound.toISOString();
}

export function applyPackagePolicy(
  argv: readonly string[],
  policy: PackagePolicy,
  nowMs: number,
): PackagePolicyResult {
  const unmanaged: PackagePolicyResult = {
    argv: [...argv],
    managed: false,
    runner: null,
    name: null,
    requestedSpec: null,
    spec: null,
    pinnedVersion: null,
    cutoff: null,
  };
  let parsed: ParsedRunner | null = null;
  if (argv[0] === "npx") parsed = parseNpx(argv);
  else if (argv[0] === "uvx") parsed = parseUvx(argv);
  if (!parsed) return unmanaged;

  const { runner, spec, specIndex, dateFlagIndex } = parsed;
  const requestedSpec = argv[specIndex];
  const base = { managed: true, runner, name: spec.name, requestedSpec };
  const existingCutoff =
    dateFlagIndex === -1 ? null : existingFlagCutoff(argv[dateFlagIndex], nowMs);

  if (policy.mode === "pinned") {
    if (spec.version.kind === "exact") {
      return {
        ...base,
        argv: [...argv],
        spec: requestedSpec,
        pinnedVersion: spec.version.version,
        cutoff: existingCutoff,
      };
    }
    if (existingCutoff !== null) {
      return {
        ...base,
        argv: [...argv],
        spec: requestedSpec,
        pinnedVersion: null,
        cutoff: existingCutoff,
      };
    }
  }

  const out = [...argv];
  if (policy.mode !== "pinned" || spec.version.kind !== "exact") out[specIndex] = spec.bare;
  const effectiveSpec = out[specIndex];

  if (policy.mode === "latest") {
    if (dateFlagIndex !== -1) out.splice(dateFlagIndex, 1);
    return { ...base, argv: out, spec: effectiveSpec, pinnedVersion: null, cutoff: null };
  }

  const iso = cutoffIso(nowMs, policy.minAgeDays);
  const flag = dateFlag(runner, iso, clampDays(policy.minAgeDays));
  if (dateFlagIndex !== -1) out[dateFlagIndex] = flag;
  else out.splice(1, 0, flag);
  return { ...base, argv: out, spec: effectiveSpec, pinnedVersion: null, cutoff: iso };
}
