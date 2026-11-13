import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { app } from "electron";
import type { HelperTarget } from "../helper-process.js";
import { atsSignals, inspectSection } from "./inspect-mac.js";
import {
  candidateScope as sharedCandidateScope,
  checkDataDir as sharedCheckDataDir,
  findSecrets,
  MAX_HITS,
  PATTERNS,
  prefixOf,
  runFiles as sharedRunFiles,
  runNetwork as sharedRunNetwork,
  runSecretsScan as sharedRunSecretsScan,
  type Args,
  type Hit,
  type Result,
  type SecurityInput,
  type SecurityPlatform,
} from "../security.js";

// The macOS side of the desktop security tools: the paths no tool may read (keychains, ssh and
// gpg keys, browser profiles, password managers, Pimi), the roots too broad to be one app's, and
// the app's preferences. The rest is shared (../security.ts).

const execFileAsync = promisify(execFile);

function namesIn(dir: string, match: RegExp): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => match.test(name))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

function denyList(): string[] {
  const home = os.homedir();
  const lib = path.join(home, "Library");
  const support = path.join(lib, "Application Support");
  const bundle = path.resolve(process.execPath, "..", "..", "..");
  return [
    path.join(lib, "Keychains"),
    path.join(home, ".ssh"),
    path.join(home, ".gnupg"),
    path.join(home, ".pimi"),
    path.join(home, ".aws"),
    path.join(home, ".kube"),
    path.join(home, ".config", "gcloud"),
    app.getPath("userData"),
    bundle,
    path.join(support, "Pimi"),
    path.join(lib, "Logs", "Pimi"),
    ...namesIn(path.join(lib, "Containers"), /^com\.pimi\./i),
    ...namesIn(path.join(lib, "Caches"), /^com\.pimi\./i),
    // Browser profiles: cookies, saved logins, history.
    ...[
      "Google/Chrome",
      "Chromium",
      "BraveSoftware",
      "Microsoft Edge",
      "Vivaldi",
      "Opera Software",
      "com.operasoftware.Opera",
      "Firefox",
      "Arc",
      "Zen",
      "Orion",
    ].map((name) => path.join(support, ...name.split("/"))),
    path.join(lib, "Safari"),
    path.join(lib, "Cookies"),
    path.join(lib, "Containers", "com.apple.Safari"),
    // Password managers and the owner's messages and mail.
    ...["1Password", "Bitwarden", "Dashlane", "Keeper", "LastPass", "NordPass", "Enpass"].map(
      (name) => path.join(support, name),
    ),
    ...namesIn(
      path.join(lib, "Group Containers"),
      /agilebits|1password|bitwarden|dashlane|keeper|lastpass|nordpass|enpass/i,
    ),
    ...namesIn(
      path.join(lib, "Containers"),
      /agilebits|1password|bitwarden|dashlane|keeper|lastpass|nordpass|enpass/i,
    ),
    path.join(lib, "Messages"),
    path.join(lib, "Mail"),
    path.join(lib, "Mobile Documents"),
    path.join(lib, "Passes"),
  ];
}

function broadRoots(): string[] {
  const home = os.homedir();
  const lib = path.join(home, "Library");
  return [
    home,
    lib,
    path.join(lib, "Application Support"),
    path.join(lib, "Containers"),
    path.join(lib, "Group Containers"),
    path.join(lib, "Caches"),
    path.join(lib, "Logs"),
    path.join(lib, "Preferences"),
    ...["Documents", "Desktop", "Downloads", "Movies", "Music", "Pictures"].map((name) =>
      path.join(home, name),
    ),
    "/Applications",
    "/System",
    "/Library",
    "/Users",
    "/usr",
    "/private",
    "/var",
    "/Volumes",
    "/",
  ];
}

// The app's preferences: ~/Library/Preferences/<bundle id>.plist, or the one in its container.
// `plutil -p` prints every plist type (a JSON conversion refuses dates and data), one key per line;
// the shared patterns find secrets in "key => value" lines turned into "key: value".
async function preferenceHits(input: SecurityInput): Promise<Hit[]> {
  const id = input.guard.bundleId;
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(id)) return [];
  const home = os.homedir();
  const files = [
    path.join(home, "Library", "Preferences", `${id}.plist`),
    path.join(home, "Library", "Containers", id, "Data", "Library", "Preferences", `${id}.plist`),
  ];
  const hits: Hit[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = (
        await execFileAsync("/usr/bin/plutil", ["-p", file], { timeout: 4000, maxBuffer: 8 << 20 })
      ).stdout;
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const key = /^\s*"([^"]+)" =>/.exec(line)?.[1] ?? "plist";
      for (const hit of findSecrets(line.replace(" => ", ": "), PATTERNS)) {
        if (hits.length >= MAX_HITS) return hits;
        hits.push({
          where: `preferences/${key}`.slice(0, 300),
          kind: hit.kind,
          valuePrefix: prefixOf(hit.value),
          valueLength: hit.value.length,
        });
      }
    }
  }
  return hits;
}

const macSecurity: SecurityPlatform = {
  denyList,
  broadRoots,
  storeHits: (_scope, input) => preferenceHits(input),
  signalSections: ["commandline"],
  inspect: inspectSection,
  configSignals: atsSignals,
};

export function candidateScope(target: HelperTarget) {
  return sharedCandidateScope(macSecurity, target);
}

// A typed folder may start with ~; it must be absolute, since a relative one would resolve against
// whatever directory the app was started from.
export function checkDataDir(raw: string) {
  const typed = raw.trim();
  const expanded =
    typed === "~" || typed.startsWith("~/") ? path.join(os.homedir(), typed.slice(1)) : typed;
  return path.isAbsolute(expanded)
    ? sharedCheckDataDir(macSecurity, expanded)
    : Promise.resolve(null);
}

export function runSecretsScan(args: Args<"secrets_scan">, input: SecurityInput) {
  return sharedRunSecretsScan(macSecurity, args, input);
}

export function runFiles(args: Args<"files">, input: SecurityInput): Promise<Result<"files">> {
  return sharedRunFiles(macSecurity, args, input);
}

export function runNetwork(input: SecurityInput): Promise<Result<"network">> {
  return sharedRunNetwork(macSecurity, input);
}
