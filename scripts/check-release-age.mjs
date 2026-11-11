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
// Exact versions let through before they are MIN_DAYS old, each after a manual review of
// its diff against the previous version and a lookup in Aikido's malware feed. Remove an
// entry once it is old enough; never add a range or a bare name.
const REVIEWED = new Map([
  ["ansi-regex@6.6.0", "2026-11-11 diff vs 6.2.2 reviewed, not in Aikido feed"],
  ["ws@8.22.2", "2026-11-11 security fix; diff vs 8.22.1 reviewed, not in Aikido feed"],
  ["hono@4.13.17", "2026-11-11 security fix; diff vs 4.13.16 reviewed, not in Aikido feed"],
  ["undici@7.30.2", "2026-11-11 security fix; diff vs 7.30.1 reviewed, not in Aikido feed"],
  ["glob@14.0.4", "2026-11-11 security fix; diff vs 14.0.3 reviewed, not in Aikido feed"],
  ["glob@13.0.7", "2026-11-11 security fix; diff vs 13.0.6 reviewed, not in Aikido feed"],
  [
    "follow-redirects@1.16.3",
    "2026-11-11 security fix; diff vs 1.16.2 reviewed, not in Aikido feed",
  ],
  ["minimatch@11.0.5", "2026-11-11 security fix; diff vs 11.0.4 reviewed, not in Aikido feed"],
  ["node-forge@1.4.3", "2026-11-11 security fix; diff vs 1.4.2 reviewed, not in Aikido feed"],
  [
    "@isaacs/nonrecursive-glob-match@1.1.0",
    "2026-11-11 diff vs 1.0.3 reviewed, not in Aikido feed",
  ],
]);

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
  const reviewed = REVIEWED.get(`${pkg.name}@${pkg.version}`);
  if (days < MIN_DAYS && reviewed) {
    console.log(`${pkg.name}@${pkg.version}: ${days.toFixed(1)} days old, allowed (${reviewed})`);
    return;
  }
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
