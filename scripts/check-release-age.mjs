#!/usr/bin/env node
// Fails when package-lock.json contains an npm package version published fewer than
// MIN_DAYS days ago. With a git ref argument, only versions added since that ref are
// checked; without one, the whole lockfile is checked. `.npmrc` sets the same limit
// for `npm install`/`npm update`; this covers `npm ci`, which never re-resolves.
//
// Usage: node scripts/check-release-age.mjs [base-ref]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const MIN_DAYS = 10;
const REGISTRY = "https://registry.npmjs.org/";
const CONCURRENCY = 16;

function lockPackages(text) {
  const lock = JSON.parse(text);
  const out = new Map();
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path.includes("node_modules/") || entry.link || entry.inBundle) continue;
    const name = entry.name ?? path.slice(path.lastIndexOf("node_modules/") + 13);
    out.set(`${name}@${entry.version}`, { name, version: entry.version, resolved: entry.resolved });
  }
  return out;
}

const base = process.argv[2];
const head = lockPackages(readFileSync("package-lock.json", "utf8"));
const before = base
  ? lockPackages(
      execFileSync("git", ["show", `${base}:package-lock.json`], {
        encoding: "utf8",
        maxBuffer: 1 << 28,
      }),
    )
  : new Map();
const toCheck = [...head.entries()].filter(([key]) => !before.has(key)).map(([, pkg]) => pkg);

const failures = [];
const now = Date.now();

async function check(pkg) {
  if (!pkg.resolved?.startsWith(REGISTRY)) {
    failures.push(
      `${pkg.name}@${pkg.version}: not from the npm registry (${pkg.resolved ?? "no resolved url"})`,
    );
    return;
  }
  const url = REGISTRY + pkg.name.replace("/", "%2f");
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    failures.push(`${pkg.name}@${pkg.version}: registry returned ${res.status}`);
    return;
  }
  const published = (await res.json()).time?.[pkg.version];
  if (!published) {
    failures.push(`${pkg.name}@${pkg.version}: no publish time in the registry`);
    return;
  }
  const days = (now - Date.parse(published)) / 86_400_000;
  if (days < MIN_DAYS) {
    failures.push(
      `${pkg.name}@${pkg.version}: published ${published} (${days.toFixed(1)} days ago)`,
    );
  }
}

const queue = [...toCheck];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let pkg = queue.shift(); pkg; pkg = queue.shift()) {
      try {
        await check(pkg);
      } catch (error) {
        failures.push(`${pkg.name}@${pkg.version}: ${error.message}`);
      }
    }
  }),
);

console.log(
  `Checked ${toCheck.length} package versions ${base ? `added since ${base}` : "in package-lock.json"}.`,
);
if (failures.length > 0) {
  console.error(`Packages must be at least ${MIN_DAYS} days old:\n${failures.sort().join("\n")}`);
  process.exit(1);
}
