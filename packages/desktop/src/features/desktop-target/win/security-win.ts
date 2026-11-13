import os from "node:os";
import path from "node:path";
import { checkDeeplink as checkSharedDeeplink } from "../deeplink.js";
import type { HelperTarget } from "../helper-process.js";
import {
  candidateScope as sharedCandidateScope,
  checkDataDir as sharedCheckDataDir,
  MAX_HITS,
  runFiles as sharedRunFiles,
  runNetwork as sharedRunNetwork,
  runSecretsScan as sharedRunSecretsScan,
  type Args,
  type Hit,
  type Result,
  type SecurityInput,
  type SecurityPlatform,
} from "../security.js";

// The Windows side of the desktop security tools: the paths no tool may read, the roots too broad
// to be one app's own, the app's registry key, and the deep link schemes that are never an app's
// own. The rest is shared (../security.ts).

function envDir(name: string): string | null {
  const value = process.env[name];
  return value ? value : null;
}

// Paths no tool may read, even when the owner's app lives under them: browser profiles, Pimi, and
// credential stores.
function denyList(): string[] {
  const local = envDir("LOCALAPPDATA");
  const roaming = envDir("APPDATA");
  const home = os.homedir();
  const under = (base: string | null, ...parts: string[]): string[] =>
    base ? [path.join(base, ...parts)] : [];
  return [
    ...under(local, "Google", "Chrome", "User Data"),
    ...under(local, "Google", "Chrome SxS", "User Data"),
    ...under(local, "Microsoft", "Edge", "User Data"),
    ...under(local, "BraveSoftware"),
    ...under(local, "Vivaldi"),
    ...under(local, "Chromium"),
    ...under(local, "Opera Software"),
    ...under(local, "Mozilla", "Firefox"),
    ...under(roaming, "Mozilla", "Firefox"),
    ...under(roaming, "Opera Software"),
    ...under(roaming, "Pimi"),
    ...under(local, "Pimi"),
    ...under(home, ".pimi"),
    path.dirname(process.execPath),
    ...under(roaming, "Microsoft", "Credentials"),
    ...under(roaming, "Microsoft", "Protect"),
    ...under(roaming, "Microsoft", "Vault"),
    ...under(local, "Microsoft", "Credentials"),
    ...under(local, "Microsoft", "Vault"),
    ...under(home, ".ssh"),
    ...under(home, ".gnupg"),
  ];
}

// Roots too broad to be one app's own: a confirmed dir may not be one of these or contain one,
// or it would take in other apps' data.
function broadRoots(): string[] {
  return [
    os.homedir(),
    envDir("APPDATA"),
    envDir("LOCALAPPDATA"),
    envDir("PROGRAMDATA"),
    envDir("SystemRoot"),
    envDir("ProgramFiles"),
    envDir("ProgramFiles(x86)"),
    envDir("SystemDrive") ? `${envDir("SystemDrive")}\\` : null,
  ].filter((value): value is string => value !== null && value !== "");
}

// The helper reads the registry; its findings come back with the scope reply.
function registryHits(raw: unknown[]): Hit[] {
  const out: Hit[] = [];
  for (const item of raw.slice(0, MAX_HITS)) {
    const entry = item as Record<string, unknown>;
    if (typeof entry.where !== "string" || typeof entry.kind !== "string") continue;
    out.push({
      where: entry.where.slice(0, 300),
      kind: entry.kind.slice(0, 60),
      valuePrefix: typeof entry.valuePrefix === "string" ? entry.valuePrefix.slice(0, 4) : "",
      valueLength:
        typeof entry.valueLength === "number" && entry.valueLength >= 0
          ? Math.floor(entry.valueLength)
          : 0,
    });
  }
  return out;
}

const winSecurity: SecurityPlatform = {
  denyList,
  broadRoots,
  storeHits: async (scope) => registryHits(Array.isArray(scope.registry) ? scope.registry : []),
  signalSections: ["commandline", "dotnet"],
};

export function candidateScope(target: HelperTarget) {
  return sharedCandidateScope(winSecurity, target);
}

export function checkDataDir(raw: string) {
  return sharedCheckDataDir(winSecurity, raw);
}

export function runSecretsScan(args: Args<"secrets_scan">, input: SecurityInput) {
  return sharedRunSecretsScan(winSecurity, args, input);
}

export function runFiles(args: Args<"files">, input: SecurityInput): Promise<Result<"files">> {
  return sharedRunFiles(winSecurity, args, input);
}

export function runNetwork(input: SecurityInput): Promise<Result<"network">> {
  return sharedRunNetwork(winSecurity, input);
}

// Schemes that are never a custom handler of the app: the helper checks the registered handler,
// and this keeps the tool from being used as a general URL opener.
const NOT_CUSTOM_SCHEMES =
  /^(?:https?|file|ftps?|javascript|data|vbscript|about|mailto|tel|sms|smb|ssh|telnet|ldaps?|shell|search-ms|ms-[a-z-]+|windows[a-z-]*|microsoft-edge|chrome|view-source)$/i;

export function checkDeeplink(url: string): void {
  checkSharedDeeplink(url, NOT_CUSTOM_SCHEMES);
}
