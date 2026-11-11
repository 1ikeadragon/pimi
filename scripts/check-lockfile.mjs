#!/usr/bin/env node
// Checks that every package in package-lock.json comes from the npm registry as a tarball with a
// sha512 integrity. Fails on a git, file, http, or other-registry source, a missing or weaker
// integrity, a link or folder that is not a root workspace, and a bundled dependency. Fails closed:
// an unreadable or suspiciously small lockfile, or a validator that lets a planted bad entry
// through, fails the run, so the check can't pass by checking nothing.
//
// Usage: node scripts/check-lockfile.mjs [path/to/package-lock.json]
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const REGISTRY = "https://registry.npmjs.org/";
const MIN_LOCK_PACKAGES = 1_000; // the lockfile had 2,250 registry packages on 2026-11-11
const SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;

const lockPath = process.argv[2] ?? "package-lock.json";

function fail(message) {
  console.error(`Lockfile check failed: ${message}`);
  process.exit(1);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`cannot read ${path}: ${error.message}`);
  }
}

// The registry serves every tarball at one URL derived from the package name and version, so an
// entry that resolves anywhere else, including through an alias to another name, stands out.
function registryProblem(key, entry) {
  const name = entry.name ?? key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
  if (typeof entry.version !== "string" || entry.version.length === 0) return "has no version";
  const expected = `${REGISTRY}${name}/-/${name.split("/").pop()}-${entry.version}.tgz`;
  if (entry.resolved !== expected)
    return `resolves from ${entry.resolved ?? "nowhere"}, expected ${expected}`;
  if (typeof entry.integrity !== "string" || !SHA512.test(entry.integrity)) {
    return `has integrity ${entry.integrity ?? "none"}, expected one sha512 hash`;
  }
  return null;
}

function problemsIn(lock, workspaces) {
  const problems = [];
  let registryPackages = 0;
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === "") continue;
    if (!key.includes("node_modules/")) {
      if (!workspaces.has(key)) problems.push(`${key}: folder is not a root workspace`);
      continue;
    }
    if (entry.link) {
      if (!workspaces.has(entry.resolved)) {
        problems.push(`${key}: links to ${entry.resolved}, which is not a root workspace`);
      }
      continue;
    }
    // A bundled dependency ships inside its parent's tarball with no integrity of its own.
    if (entry.inBundle) {
      problems.push(`${key}: bundled dependency without its own integrity`);
      continue;
    }
    registryPackages += 1;
    const problem = registryProblem(key, entry);
    if (problem) problems.push(`${key}: ${problem}`);
  }
  return { problems, registryPackages };
}

const lock = readJson(lockPath);
if (lock.lockfileVersion !== 3) fail(`expected lockfileVersion 3, got ${lock.lockfileVersion}`);
if (!lock.packages || typeof lock.packages !== "object") fail("the lockfile has no packages map");
const rootPackage = readJson(join(dirname(lockPath), "package.json"));
const workspaces = new Set(
  (rootPackage.workspaces ?? []).map((w) => relative(".", join(".", w)).replaceAll("\\", "/")),
);

// Prove the validator rejects each source it exists to catch, every run.
const planted = {
  "node_modules/a": { version: "1.0.0", resolved: "git+ssh://git@github.com/a/a.git#0123456" },
  "node_modules/b": { version: "1.0.0", resolved: "file:../b-1.0.0.tgz" },
  "node_modules/c": {
    version: "1.0.0",
    resolved: "http://registry.npmjs.org/c/-/c-1.0.0.tgz",
    integrity: `sha512-${"A".repeat(86)}==`,
  },
  "node_modules/d": {
    version: "1.0.0",
    resolved: `${REGISTRY}d/-/d-1.0.0.tgz`,
    integrity: "sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  },
  "node_modules/e": { name: "e", version: "1.0.0", resolved: `${REGISTRY}x/-/x-1.0.0.tgz` },
  "node_modules/f": { link: true, resolved: "../outside" },
  "node_modules/g": { version: "1.0.0", inBundle: true },
  outside: { version: "1.0.0" },
};
const canary = problemsIn({ packages: planted }, workspaces);
if (canary.problems.length !== Object.keys(planted).length) {
  fail(
    `the validator caught ${canary.problems.length} of ${Object.keys(planted).length} planted entries`,
  );
}

const { problems, registryPackages } = problemsIn(lock, workspaces);
if (registryPackages < MIN_LOCK_PACKAGES) {
  fail(`${lockPath} lists only ${registryPackages} registry packages`);
}
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  fail(`${problems.length} of ${registryPackages} registry packages failed`);
}
console.log(
  `Lockfile check passed: ${registryPackages} packages resolve from ${REGISTRY} with sha512 integrity.`,
);
