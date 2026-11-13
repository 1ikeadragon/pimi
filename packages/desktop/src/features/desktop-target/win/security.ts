import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  DesktopTargetCommand,
  DesktopTargetResult,
} from "@pimi/protocol/desktop-target/rpc-schemas";
import type { DesktopGuard } from "../guard.js";
import {
  betterleaksPath,
  helperRequest,
  HelperError,
  type HelperTarget,
} from "../helper-process.js";

const execFileAsync = promisify(execFile);

// The Node side of the desktop security tools (SECURITY-DESIGN.md section 3). The helper owns
// every Win32 fact and resolves the install dir; this file owns the file walker, the secret
// patterns and their redaction, the glob and size caps, and the allowlist and deny-list checks.
// Nothing here opens a file for write. A secret value never leaves this file: findings carry
// { where, kind, valuePrefix (at most 4 characters), valueLength } and file reads come back with
// secret-shaped values replaced.

type Args<K extends DesktopTargetCommand["command"]> = Extract<
  DesktopTargetCommand,
  { command: K }
>["args"];
type Result<K extends DesktopTargetResult["command"]> = Extract<
  DesktopTargetResult,
  { command: K }
>;

export interface SecurityInput {
  guard: DesktopGuard;
  agentId: string;
  target: HelperTarget;
}

function refuse(message: string): never {
  throw new HelperError("refused", message);
}

// ---- scope ----

interface ScopeRoot {
  /** What the agent calls the root: "install", "data1", "data2", ... */
  name: "install" | `data${number}`;
  kind: "install" | "data";
  /** Canonical absolute path (symlinks and junctions resolved). */
  dir: string;
}

function norm(value: string): string {
  return path
    .normalize(value)
    .replace(/[\\/]+$/, "")
    .toLowerCase();
}

function isWithin(child: string, parent: string): boolean {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(`${p}${path.sep}`);
}

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

function deniedReason(dir: string): string | null {
  const parts = norm(dir).split(path.sep);
  if (parts.includes(".ssh") || parts.includes(".gnupg")) return "a credential store";
  if (denyList().some((denied) => isWithin(dir, denied))) {
    return "a browser profile, Pimi or a credential store";
  }
  return null;
}

async function canonicalDir(raw: string): Promise<string | null> {
  try {
    const real = await fs.realpath(raw);
    return (await fs.stat(real)).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

async function acceptRoot(
  name: ScopeRoot["name"],
  kind: ScopeRoot["kind"],
  raw: string,
): Promise<ScopeRoot | null> {
  const dir = await canonicalDir(raw);
  if (!dir) return null;
  if (deniedReason(dir)) return null;
  if (broadRoots().some((broad) => isWithin(broad, dir))) {
    return null;
  }
  return { name, kind, dir };
}

interface ResolvedScope {
  roots: ScopeRoot[];
  registry: unknown[];
}

// The helper names the install dir (authoritative, from the pinned process); the data dirs are
// the ones the owner confirmed in the launch form. Both are re-checked here against the deny-list.
async function resolveScope(input: SecurityInput, registry: boolean): Promise<ResolvedScope> {
  const reply = await helperRequest({
    verb: "scope",
    agent: input.agentId,
    target: input.target,
    args: registry ? { registry: true } : {},
  });
  const roots: ScopeRoot[] = [];
  if (typeof reply.installDir === "string") {
    const install = await acceptRoot("install", "install", reply.installDir);
    if (install) roots.push(install);
  }
  let index = 0;
  for (const raw of input.guard.dataDirs) {
    index += 1;
    const data = await acceptRoot(`data${index}`, "data", raw);
    if (data) roots.push(data);
  }
  return { roots, registry: Array.isArray(reply.registry) ? reply.registry : [] };
}

/**
 * The install dir and candidate data dirs for the launch form to show: the helper derives them
 * from the picked window, and the deny-list and broad-root rules drop what must never be read.
 * The owner edits the list, and every read re-checks it.
 */
export async function candidateScope(
  target: HelperTarget,
): Promise<{ installDir: string | null; dataDirs: string[] }> {
  const reply = await helperRequest({ verb: "scope", agent: "owner", target, args: {} });
  const install =
    typeof reply.installDir === "string"
      ? await acceptRoot("install", "install", reply.installDir)
      : null;
  const candidates = Array.isArray(reply.dataDirs) ? reply.dataDirs : [];
  const dataDirs: string[] = [];
  for (const raw of candidates.slice(0, 20)) {
    if (typeof raw !== "string") continue;
    const accepted = await acceptRoot("data1", "data", raw);
    if (accepted && !dataDirs.includes(accepted.dir)) dataDirs.push(accepted.dir);
  }
  return { installDir: install?.dir ?? null, dataDirs };
}

/** The same rules for a directory the owner typed into the launch form. */
export async function checkDataDir(raw: string): Promise<string | null> {
  return (await acceptRoot("data1", "data", raw))?.dir ?? null;
}

// ---- secret patterns ----

interface SecretPattern {
  kind: string;
  re: RegExp;
  /** The capture group that holds the secret; 0 is the whole match. */
  group: number;
  /** Minimum Shannon entropy per character of the value, for patterns that match plain words. */
  minEntropy?: number;
}

const PATTERNS: readonly SecretPattern[] = [
  { kind: "private-key", re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?-----/dg, group: 0 },
  {
    kind: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/dg,
    group: 0,
  },
  { kind: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/dg, group: 0 },
  {
    kind: "github-token",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/dg,
    group: 0,
  },
  { kind: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/dg, group: 0 },
  { kind: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/dg, group: 0 },
  { kind: "stripe-key", re: /\b[sr]k_live_[0-9a-zA-Z]{16,}/dg, group: 0 },
  {
    kind: "discord-token",
    re: /\b[MNO][A-Za-z\d_-]{23,25}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}/dg,
    group: 0,
  },
  { kind: "bearer-token", re: /\bBearer\s+([A-Za-z0-9._~+/-]{20,}=*)/dg, group: 1, minEntropy: 3 },
  {
    kind: "connection-string-password",
    re: /\b(?:Password|Pwd)\s*=\s*([^;"'\s<>]{3,})/dgi,
    group: 1,
  },
  {
    kind: "url-credentials",
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:([^\s@/]{3,})@/dgi,
    group: 1,
  },
  {
    kind: "secret-assignment",
    re: /(?:api[_-]?key|secret|token|passwd|password|auth[_-]?token|access[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']?([A-Za-z0-9_\-/+=.]{12,})/dgi,
    group: 1,
    minEntropy: 3,
  },
];

const HIGH_ENTROPY: SecretPattern = {
  kind: "high-entropy",
  re: /[A-Za-z0-9+/_-]{32,256}={0,2}/dg,
  group: 0,
  minEntropy: 4.5,
};

const PLACEHOLDER =
  /(?:change.?me|your[_-]|example|placeholder|dummy|sample|xxxx|\*{4}|<[^>]+>|\$\{|%[A-Za-z_]+%|\{\{)/i;

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

interface RawHit {
  kind: string;
  start: number;
  end: number;
  value: string;
}

function findSecrets(text: string, patterns: readonly SecretPattern[]): RawHit[] {
  const hits: RawHit[] = [];
  for (const pattern of patterns) {
    pattern.re.lastIndex = 0;
    let match = pattern.re.exec(text);
    while (match) {
      const span = match.indices?.[pattern.group];
      const value = match[pattern.group];
      if (span && value !== undefined && value.length > 0) {
        const plain = pattern.kind === "private-key" || !PLACEHOLDER.test(value);
        const rich = pattern.minEntropy === undefined || entropy(value) >= pattern.minEntropy;
        if (plain && rich) hits.push({ kind: pattern.kind, start: span[0], end: span[1], value });
      }
      if (match[0].length === 0) pattern.re.lastIndex += 1;
      match = pattern.re.exec(text);
    }
  }
  // A span a more specific pattern already claimed is not reported again.
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: RawHit[] = [];
  for (const hit of hits) {
    const last = kept[kept.length - 1];
    if (last && hit.start < last.end) continue;
    kept.push(hit);
  }
  return kept;
}

// Enough of a value to tell kinds apart, never enough to use it: short values show nothing.
function prefixOf(value: string): string {
  if (value.length >= 12) return value.slice(0, 4);
  if (value.length >= 8) return value.slice(0, 2);
  return "";
}

function redactedText(text: string): string {
  const hits = findSecrets(text, [...PATTERNS, HIGH_ENTROPY]);
  let out = "";
  let at = 0;
  for (const hit of hits) {
    out += text.slice(at, hit.start);
    const prefix = prefixOf(hit.value);
    out += `[redacted ${hit.kind}, ${hit.value.length} chars${prefix ? `, starts ${JSON.stringify(prefix)}` : ""}]`;
    at = hit.end;
  }
  return out + text.slice(at);
}

// ---- betterleaks ----

interface BetterleaksFinding {
  RuleID: string;
  Description: string;
  StartLine: number;
  EndLine: number;
  Secret: string;
  File: string;
  Entropy: number;
  Attributes?: { confidence?: string };
}

const MAX_HITS = 500;

// ---- secrets_scan ----

const BETTERLEAKS_TIMEOUT_S = 20;

async function runBetterleaks(dir: string): Promise<BetterleaksFinding[]> {
  const exe = betterleaksPath();
  if (!existsSync(exe)) {
    throw new HelperError("failed", `betterleaks not found at ${exe}`);
  }
  try {
    const { stdout } = await execFileAsync(
      exe,
      [
        "dir",
        "--no-banner",
        "--no-color",
        "--redact=80",
        "-f",
        "json",
        "-r",
        "-",
        "--exit-code",
        "0",
        "--timeout",
        String(BETTERLEAKS_TIMEOUT_S),
        "--confidence",
        "low",
        dir,
      ],
      { timeout: (BETTERLEAKS_TIMEOUT_S + 5) * 1000, maxBuffer: 10 * 1024 * 1024 },
    );
    if (!stdout.trim()) return [];
    return JSON.parse(stdout) as BetterleaksFinding[];
  } catch (error: unknown) {
    const err = error as { stdout?: string; code?: string; killed?: boolean };
    if (err.killed) return [];
    if (err.stdout?.trim()) {
      try {
        return JSON.parse(err.stdout) as BetterleaksFinding[];
      } catch {
        return [];
      }
    }
    return [];
  }
}

function registryHits(raw: unknown[]): Result<"secrets_scan">["hits"] {
  const out: Result<"secrets_scan">["hits"] = [];
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

function findingToHit(
  finding: BetterleaksFinding,
  rootName: string,
  rootDir: string,
): Result<"secrets_scan">["hits"][number] {
  const rel = path.relative(rootDir, finding.File).replaceAll("\\", "/");
  const where = `${rootName}/${rel}:${finding.StartLine}`;
  const secret = finding.Secret ?? "";
  return {
    where,
    kind: finding.RuleID,
    valuePrefix: prefixOf(secret),
    valueLength: secret.length,
  };
}

export async function runSecretsScan(
  args: Args<"secrets_scan">,
  input: SecurityInput,
): Promise<Result<"secrets_scan">> {
  const wanted = new Set(args.roots ?? ["data", "install"]);
  const scope = await resolveScope(input, wanted.has("registry"));
  const roots = scope.roots.filter((root) => wanted.has(root.kind));
  if (roots.length === 0 && !wanted.has("registry")) {
    refuse(
      "No scan root is available: the install dir could not be resolved, and no data dir the owner confirmed exists.",
    );
  }
  const hits: Result<"secrets_scan">["hits"] = [];
  let filesScanned = 0;
  let truncated = false;
  for (const root of roots) {
    const findings = await runBetterleaks(root.dir);
    const seen = new Set<string>();
    for (const f of findings) {
      if (f.File) seen.add(f.File);
      if (hits.length >= MAX_HITS) {
        truncated = true;
        break;
      }
      hits.push(findingToHit(f, root.name, root.dir));
    }
    filesScanned += seen.size;
  }
  if (wanted.has("registry")) {
    const registry = registryHits(scope.registry);
    hits.push(...registry);
  }
  const lines = [
    `Scanned ${roots.map((r) => r.name).join(", ") || "no root"} with betterleaks v1.10.1.`,
    hits.length === 0
      ? "No secrets found."
      : `${hits.length} finding${hits.length === 1 ? "" : "s"}:`,
    ...hits.map(
      (h) =>
        `- ${h.where} ${h.kind}${h.valuePrefix ? ` ${JSON.stringify(h.valuePrefix)}` : ""} (${h.valueLength} chars)`,
    ),
  ];
  if (truncated) lines.push("Truncated: hit cap reached.");
  return {
    command: "secrets_scan",
    report: lines.join("\n"),
    hits,
    filesScanned,
    truncated,
  };
}

// ---- files ----

function looksBinary(buffer: Buffer): boolean {
  const end = Math.min(buffer.length, 8192);
  for (let index = 0; index < end; index += 1) if (buffer[index] === 0) return true;
  return false;
}

async function readHead(file: string, max: number): Promise<{ buffer: Buffer; size: number }> {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.min(size, max));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { buffer: buffer.subarray(0, bytesRead), size };
  } finally {
    await handle.close();
  }
}

const MAX_LIST_ENTRIES = 300;
const DEFAULT_READ_BYTES = 65_536;

function pickRoot(roots: readonly ScopeRoot[], relative: string): { root: ScopeRoot; rel: string } {
  const clean = relative.replaceAll("\\", "/").replace(/^\/+/, "");
  const [first = "", ...rest] = clean.split("/");
  const root = roots.find((candidate) => candidate.name === first.toLowerCase());
  if (!root) {
    refuse(
      `Start the path with a scope root name (${roots.map((r) => r.name).join(", ") || "none available"}); list with an empty path shows them.`,
    );
  }
  return { root, rel: rest.join("/") };
}

async function resolveInside(root: ScopeRoot, rel: string): Promise<string> {
  if (rel.split("/").includes("..")) refuse("Paths with .. are refused.");
  const joined = path.join(root.dir, ...rel.split("/").filter(Boolean));
  let real: string;
  try {
    real = await fs.realpath(joined);
  } catch {
    refuse("That path does not exist.");
  }
  if (!isWithin(real, root.dir)) refuse("That path leaves the app's own directory.");
  const denied = deniedReason(real);
  if (denied) refuse(`That path is ${denied}.`);
  return real;
}

export async function runFiles(
  args: Args<"files">,
  input: SecurityInput,
): Promise<Result<"files">> {
  const { roots } = await resolveScope(input, false);
  if (args.path.trim() === "") {
    if (args.action === "read") refuse("read needs a file path.");
    const report = roots.length
      ? roots.map((root) => `${root.name}/  (${root.kind} dir)`).join("\n")
      : "No scope roots are available.";
    return { command: "files", report, bytes: Buffer.byteLength(report), truncated: false };
  }
  const { root, rel } = pickRoot(roots, args.path);
  const real = await resolveInside(root, rel);
  const stat = await fs.stat(real);
  if (args.action === "list") {
    if (!stat.isDirectory()) refuse("That is a file; use read.");
    const entries = await fs.readdir(real, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const shown = entries.filter((entry) => !entry.isSymbolicLink()).slice(0, MAX_LIST_ENTRIES);
    const lines: string[] = [];
    for (const entry of shown) {
      if (entry.isDirectory()) {
        lines.push(`${entry.name}/`);
        continue;
      }
      const size = await fs
        .stat(path.join(real, entry.name))
        .then((s) => s.size)
        .catch(() => 0);
      lines.push(`${entry.name}  ${size} bytes`);
    }
    const truncated = entries.length > MAX_LIST_ENTRIES;
    if (truncated) lines.push(`(${entries.length - MAX_LIST_ENTRIES} more not shown)`);
    const report = lines.length > 0 ? lines.join("\n") : "(empty)";
    return { command: "files", report, bytes: Buffer.byteLength(report), truncated };
  }
  if (!stat.isFile()) refuse("That is not a file.");
  const max = args.maxBytes ?? DEFAULT_READ_BYTES;
  const { buffer, size } = await readHead(real, max);
  if (looksBinary(buffer)) refuse("That is a binary file; desktop_files reads text only.");
  const report = redactedText(buffer.toString("utf8"));
  return {
    command: "files",
    report,
    bytes: buffer.length,
    truncated: size > buffer.length,
  };
}

// ---- network ----

// Remote ports that carry plain, unencrypted protocols.
const PLAINTEXT_PORTS: ReadonlySet<number> = new Set([
  21, 23, 25, 80, 110, 143, 1883, 5222, 6667, 8000, 8008, 8080, 8888,
]);

function isLoopback(address: string | null): boolean {
  return address === null || address === "::1" || address.startsWith("127.");
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

function splitAddress(value: unknown): { address: string; port: number } | null {
  if (typeof value !== "string") return null;
  const index = value.lastIndexOf(":");
  if (index < 0) return null;
  const port = Number(value.slice(index + 1));
  return Number.isInteger(port)
    ? { address: value.slice(0, index).replace(/^\[|\]$/g, ""), port }
    : null;
}

type Endpoint = Result<"network">["endpoints"][number];

// The helper's `inspect` ports section lists the process tree's sockets. Fields are read by the
// names HELPER-CONTRACT.md gives them, and a "local"/"remote" "ip:port" string is accepted too.
function endpointsFrom(structured: unknown): Endpoint[] {
  const record = structured as { ports?: unknown } | null;
  const rows = Array.isArray(record?.ports) ? (record.ports as Record<string, unknown>[]) : [];
  const out: Endpoint[] = [];
  for (const row of rows.slice(0, 500)) {
    const endpoint = endpointFrom(row);
    if (endpoint) out.push(endpoint);
  }
  return out;
}

function endpointFrom(row: Record<string, unknown>): Endpoint | null {
  const local = rowSide(row, "local");
  if (!local) return null;
  const remote = rowSide(row, "remote");
  const listening = !remote || remote.address === "0.0.0.0" || remote.address === "::";
  const remoteAddress = listening ? null : (remote?.address ?? null);
  const remotePort = listening ? null : (remote?.port ?? null);
  let state = listening ? "listening" : "established";
  if (typeof row.state === "string") state = row.state;
  return {
    protocol: row.protocol === "udp" ? "udp" : "tcp",
    localAddress: local.address,
    localPort: local.port ?? 0,
    remoteAddress,
    remotePort,
    state,
    pid: asNumber(row.pid) ?? 0,
    plaintext: remotePort !== null && !isLoopback(remoteAddress) && PLAINTEXT_PORTS.has(remotePort),
  };
}

// One end of a socket row: "localAddress"/"localPort" fields, or a "local" "ip:port" string.
function rowSide(
  row: Record<string, unknown>,
  side: "local" | "remote",
): { address: string; port: number | null } | null {
  const joined = splitAddress(row[side]);
  const address = row[`${side}Address`];
  const port = asNumber(row[`${side}Port`]) ?? joined?.port ?? null;
  const resolved = typeof address === "string" && address !== "" ? address : joined?.address;
  if (!resolved) return null;
  return side === "local" && port === null ? null : { address: resolved, port };
}

const CERT_SIGNALS: ReadonlyArray<{ re: RegExp; text: string }> = [
  {
    re: /ignore-certificate-errors/i,
    text: "The command line has --ignore-certificate-errors.",
  },
  {
    re: /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*0/,
    text: "NODE_TLS_REJECT_UNAUTHORIZED=0 appears in the app's launch environment or arguments.",
  },
  {
    re: /ServerCertificateValidationCallback|RemoteCertificateValidationCallback|DangerousAcceptAnyServerCertificateValidator/,
    text: "The .NET code references a certificate validation callback; check that it does not accept every certificate.",
  },
];

async function inspectSection(
  input: SecurityInput,
  section: string,
): Promise<Record<string, unknown> | null> {
  try {
    const reply = await helperRequest({
      verb: "inspect",
      agent: input.agentId,
      target: input.target,
      args: section === "ports" ? { section, connections: true } : { section },
    });
    const structured = reply.structured;
    return structured && typeof structured === "object"
      ? (structured as Record<string, unknown>)
      : reply;
  } catch (error) {
    // The endpoint list is the point of the call; the signal sections are best effort.
    if (section === "ports") throw error;
    return null;
  }
}

/**
 * The target's live endpoints and certificate-validation signals. The daemon adds the Network
 * monitor's launch and DNS records, which live in its process, not here.
 */
export async function runNetwork(input: SecurityInput): Promise<Result<"network">> {
  const ports = await inspectSection(input, "ports");
  const endpoints = endpointsFrom(ports);
  const evidence = JSON.stringify([
    await inspectSection(input, "commandline"),
    await inspectSection(input, "dotnet"),
  ]);
  return {
    command: "network",
    endpoints,
    certSignals: CERT_SIGNALS.filter((signal) => signal.re.test(evidence)).map(
      (signal) => signal.text,
    ),
  };
}

// ---- checks the main process applies before a call reaches the helper ----

// Schemes that are never a custom handler of the app: the helper checks the registered handler,
// and this keeps the tool from being used as a general URL opener.
const NOT_CUSTOM_SCHEMES =
  /^(?:https?|file|ftps?|javascript|data|vbscript|about|mailto|tel|sms|smb|ssh|telnet|ldaps?|shell|search-ms|ms-[a-z-]+|windows[a-z-]*|microsoft-edge|chrome|view-source)$/i;

export function checkDeeplink(url: string): void {
  const match = /^([a-z][a-z0-9+.-]{1,63}):/i.exec(url);
  if (!match) refuse("A deep link starts with the app's own scheme, such as myapp://...");
  if (NOT_CUSTOM_SCHEMES.test(match[1] ?? "")) {
    refuse(`The ${match[1]}: scheme is not a custom handler of the app.`);
  }
  const control = [...url].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
  if (control) refuse("A deep link holds no control characters.");
}

export function checkProbe(args: Args<"ipc">): void {
  if (args.action !== "probe") return;
  if (args.port === undefined) refuse("probe needs a port.");
  if (args.path !== undefined && !/^\/[\x21-\x7e]*$/.test(args.path)) {
    refuse("The probe path starts with / and holds printable characters without spaces.");
  }
}
