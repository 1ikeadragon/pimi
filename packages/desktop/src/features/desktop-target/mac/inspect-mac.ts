import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  DesktopTargetCommand,
  DesktopTargetResult,
} from "@pimi/protocol/desktop-target/rpc-schemas";
import { helperRequest, HelperError } from "../helper-process.js";
import type { SecurityInput } from "../security.js";

// The macOS `inspect` and `ipc` tools. The helper supplies the process tree (`scope`); the facts
// come from the tools every Mac has: ps, lsof, codesign, spctl, plutil, xattr. Nothing here writes,
// loads or elevates anything, and nothing runs through a shell: each call is an argv array.

const execFileAsync = promisify(execFile);

type Args<K extends DesktopTargetCommand["command"]> = Extract<
  DesktopTargetCommand,
  { command: K }
>["args"];
type Obj = Record<string, unknown>;

interface Proc {
  pid: number;
  ppid: number;
  uid: number;
  path: string;
  startedAt: string;
}

interface Scope {
  installDir: string;
  exe: string;
  bundleId: string;
  pid: number;
  procs: Proc[];
  handlers: Record<string, string>;
}

async function run(
  cmd: string,
  args: string[],
  timeout = 4000,
): Promise<{ out: string; err: string; code: number; timedOut: boolean }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8",
    });
    return { out: stdout, err: stderr, code: 0, timedOut: false };
  } catch (error) {
    const e = error as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      killed?: boolean;
    };
    return {
      out: e.stdout ?? "",
      err: e.stderr ?? "",
      code: typeof e.code === "number" ? e.code : 1,
      timedOut: e.killed === true,
    };
  }
}

async function getScope(input: SecurityInput, forInput = false): Promise<Scope> {
  const reply = await helperRequest({
    verb: "scope",
    agent: input.agentId,
    target: input.target,
    args: forInput ? { input: true } : {},
  });
  const procs = (Array.isArray(reply.procs) ? (reply.procs as Obj[]) : []).map((p) => ({
    pid: Number(p.pid),
    ppid: Number(p.ppid),
    uid: Number(p.uid),
    path: typeof p.path === "string" ? p.path : "",
    startedAt: typeof p.startedAt === "string" ? p.startedAt : "",
  }));
  return {
    installDir: typeof reply.installDir === "string" ? reply.installDir : "",
    exe: typeof reply.exe === "string" ? reply.exe : "",
    bundleId: typeof reply.bundleId === "string" ? reply.bundleId : "",
    pid: Number(reply.pid),
    procs,
    handlers: reply.handlers && typeof reply.handlers === "object" ? (reply.handlers as never) : {},
  };
}

// ---- redaction (command lines show flags, not secrets) ----

const SECRET_KEY = /(token|secret|passw|pwd|key|auth|bearer|cookie|credential|sig)/i;
const TOKEN_LIKE = /^[A-Za-z0-9_\-+/=.~]{20,}$/;
const NOTABLE =
  /^--?(inspect|inspect-brk|inspect-port|remote-debugging-port|remote-debugging-address|remote-allow-origins|no-sandbox|disable-web-security|ignore-certificate-errors|allow-running-insecure-content|user-data-dir|js-flags|proxy-server|disable-gpu-sandbox|enable-logging|trace-startup)/i;

function redactValue(key: string, value: string): string {
  if (SECRET_KEY.test(key) && value.length > 0) return `<redacted len ${value.length}>`;
  if (TOKEN_LIKE.test(value)) return `${value.slice(0, 4)}...<len ${value.length}>`;
  return value.length > 80 ? `${value.slice(0, 80)}...` : value;
}

function redactArg(arg: string): string {
  const eq = arg.indexOf("=");
  if (arg.startsWith("-") && eq < 0) return arg.length > 60 ? `${arg.slice(0, 60)}...` : arg;
  if (arg.startsWith("-") && eq > 0) {
    return arg.slice(0, eq + 1) + redactValue(arg.slice(0, eq), arg.slice(eq + 1));
  }
  if (arg.includes("://")) {
    try {
      const url = new URL(arg);
      const p = url.pathname.length > 40 ? `${url.pathname.slice(0, 40)}...` : url.pathname;
      return `${url.protocol}//${url.host}${p}${url.search ? `?<${url.search.length - 1} chars>` : ""}`;
    } catch {
      // not a URL after all
    }
  }
  return redactValue("", arg);
}

async function argsOf(pids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (pids.length === 0) return out;
  const { out: text } = await run("/bin/ps", ["-ww", "-o", "pid=,args=", "-p", pids.join(",")]);
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s(.*)$/.exec(line);
    if (match) out.set(Number(match[1]), match[2] ?? "");
  }
  return out;
}

// ps joins the arguments with spaces, so an argument that holds a space is split; the executable
// path (known from the helper) is cut off first because it often does.
function outline(exe: string, args: string | undefined): Obj {
  if (args === undefined) return { note: "command line not readable" };
  const rest = args.startsWith(exe) ? args.slice(exe.length) : args;
  const list = rest.split(/\s+/).filter(Boolean);
  return {
    exe,
    argCount: list.length,
    args: list.slice(0, 40).map(redactArg),
    notable: list
      .filter((a) => NOTABLE.test(a) || a.includes("://"))
      .slice(0, 20)
      .map(redactArg),
  };
}

// ---- text form of the structured facts ----

function scalar(value: unknown): boolean {
  return value === null || typeof value !== "object";
}

function one(value: unknown): string {
  const text = value === null ? "null" : String(value);
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

function fmtText(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  const lines: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const rec = item as Obj;
        if (Object.values(rec).every(scalar)) {
          lines.push(
            `${pad}- ${Object.entries(rec)
              .map(([k, v]) => `${k}=${one(v)}`)
              .join(" ")}`,
          );
          continue;
        }
      }
      if (scalar(item)) lines.push(`${pad}- ${one(item)}`);
      else lines.push(`${pad}-`, fmtText(item, indent + 1));
    }
  } else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value as Obj)) {
      if (scalar(inner)) lines.push(`${pad}${key}: ${one(inner)}`);
      else if (Array.isArray(inner) && inner.length === 0) lines.push(`${pad}${key}: (none)`);
      else lines.push(`${pad}${key}:`, fmtText(inner, indent + 1));
    }
  } else {
    lines.push(`${pad}${one(value)}`);
  }
  return lines.join("\n");
}

// ---- Info.plist and Mach-O ----

async function plistJson(file: string): Promise<Obj | null> {
  const { out, code } = await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", file]);
  if (code !== 0) return null;
  try {
    return JSON.parse(out) as Obj;
  } catch {
    return null;
  }
}

interface MachO {
  pie: boolean;
  allowStackExecution: boolean;
}

// Reads the header flags of a thin or universal (arm64 first) Mach-O. No otool: it is not on a
// stock Mac.
async function machO(file: string): Promise<MachO | null> {
  let handle;
  try {
    handle = await fs.open(file, "r");
    const head = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    let offset = 0;
    if (bytesRead >= 8 && head.readUInt32BE(0) === 0xcafebabe) {
      const count = head.readUInt32BE(4);
      let pick: number | null = null;
      for (let i = 0; i < Math.min(count, 8) && 8 + i * 20 + 20 <= bytesRead; i += 1) {
        const cpu = head.readUInt32BE(8 + i * 20);
        const at = head.readUInt32BE(8 + i * 20 + 8);
        if (pick === null || cpu === 0x0100000c) pick = at;
      }
      if (pick === null) return null;
      offset = pick;
    }
    const mach = Buffer.alloc(32);
    await handle.read(mach, 0, mach.length, offset);
    if (mach.readUInt32LE(0) !== 0xfeedfacf) return null;
    const flags = mach.readUInt32LE(24);
    return {
      pie: (flags & 0x200000) !== 0,
      allowStackExecution: (flags & 0x20000) !== 0,
    };
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

// ---- sections ----

function ownerName(uid: number, me: number): string {
  if (uid === 0) return "root";
  return uid === me ? "you" : `uid ${uid}`;
}

function fuseState(byte: number): string {
  if (byte === 0x31) return "enabled";
  return byte === 0x30 ? "disabled" : "removed";
}

async function sectionProcess(scope: Scope): Promise<unknown> {
  const pids = scope.procs.map((p) => p.pid);
  const ps = await run("/bin/ps", ["-o", "pid=,rss=,pcpu=", "-p", pids.join(",")]);
  const usage = new Map<number, { rss: number; cpu: number }>();
  for (const line of ps.out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)/.exec(line);
    if (m) usage.set(Number(m[1]), { rss: Number(m[2]), cpu: Number(m[3]) });
  }
  const me = os.userInfo().uid;
  return scope.procs.map((p) => {
    const use = usage.get(p.pid);
    const micros = Number(p.startedAt);
    return {
      pid: p.pid,
      parent: p.ppid,
      exe: path.basename(p.path),
      path: p.path,
      inScope: true,
      user: ownerName(p.uid, me),
      elevated: p.uid === 0,
      ...(Number.isFinite(micros) && micros > 0
        ? { startedAt: new Date(micros / 1000).toISOString() }
        : {}),
      ...(use ? { rssMB: Math.round(use.rss / 102.4) / 10, cpuPercent: use.cpu } : {}),
    };
  });
}

interface CodeSign {
  facts: Obj;
  flags: number;
  entitlements: Obj;
}

async function codesign(target: string): Promise<CodeSign> {
  const info = await run("/usr/bin/codesign", ["-dvvv", "--entitlements", "-", "--xml", target]);
  const facts: Obj = {};
  const authorities: string[] = [];
  let flags = 0;
  for (const line of info.err.split("\n")) {
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (key === "Authority") authorities.push(value);
    else if (key === "Identifier") facts.identifier = value;
    else if (key === "TeamIdentifier") facts.teamIdentifier = value;
    else if (key === "Signature") facts.signature = value;
    else if (key === "Timestamp") facts.timestamp = value;
    else if (key === "Format") facts.format = value;
    else if (key === "Info.plist entries") facts.infoPlistEntries = Number(value);
    else if (key.startsWith("CodeDirectory")) {
      const m = /flags=(0x[0-9a-f]+)/.exec(value);
      if (m) flags = Number.parseInt(m[1] ?? "0", 16);
    }
  }
  if (info.code !== 0 && !facts.identifier) {
    return {
      facts: { signed: false, note: info.err.trim().slice(0, 200) },
      flags,
      entitlements: {},
    };
  }
  facts.signed = true;
  facts.authorities = authorities;
  facts.hardenedRuntime = (flags & 0x10000) !== 0;
  // The entitlements plist is on stdout as XML; read the keys that are set to true, by name.
  const entitlements: Obj = {};
  for (const m of info.out.matchAll(/<key>([^<]+)<\/key>\s*<(true|false)\/>/g)) {
    entitlements[m[1] ?? ""] = m[2] === "true";
  }
  return { facts, flags, entitlements };
}

// codesign --verify prints progress lines first; the verdict is the line that says so.
function verifyMessage(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const verdict = lines.find((line) =>
    /valid on disk|satisfies|not signed|invalid|modified|a sealed resource/i.test(line),
  );
  return (verdict ?? lines[lines.length - 1] ?? "").slice(0, 200);
}

// Verifying a large bundle's seal and asking Gatekeeper can take several seconds.
const SLOW_MS = 15_000;

async function sectionSignature(scope: Scope): Promise<unknown> {
  const [{ facts, entitlements }, verify, gate] = await Promise.all([
    codesign(scope.installDir),
    run(
      "/usr/bin/codesign",
      ["--verify", "--deep", "--strict", "--verbose=2", scope.installDir],
      SLOW_MS,
    ),
    run("/usr/sbin/spctl", ["-a", "-vv", scope.installDir], SLOW_MS),
  ]);
  const gateText = `${gate.out}${gate.err}`;
  return {
    ...facts,
    verify: verify.timedOut
      ? { ok: "unknown", message: "codesign --verify did not finish in time" }
      : { ok: verify.code === 0, message: verifyMessage(verify.err) },
    gatekeeper: {
      accepted: gate.timedOut ? "unknown" : gate.code === 0,
      source: /source=(.*)/.exec(gateText)?.[1] ?? "",
      origin: /origin=(.*)/.exec(gateText)?.[1] ?? "",
    },
    entitlementCount: Object.keys(entitlements).length,
  };
}

const WEAK_ENTITLEMENTS: Record<string, string> = {
  "com.apple.security.cs.allow-jit": "allows JIT (writable and executable memory)",
  "com.apple.security.cs.allow-unsigned-executable-memory":
    "allows unsigned executable memory (shellcode friendly)",
  "com.apple.security.cs.disable-library-validation":
    "loads libraries signed by anyone (dylib injection)",
  "com.apple.security.cs.allow-dyld-environment-variables":
    "honours DYLD_* variables (dylib injection)",
  "com.apple.security.cs.disable-executable-page-protection": "disables executable page protection",
  "com.apple.security.cs.debugger": "may debug other processes",
  "com.apple.security.get-task-allow": "other processes may attach a debugger (debug build)",
  "com.apple.security.cs.allow-relative-library-loads": "loads libraries by relative path",
};

async function sectionMitigations(scope: Scope): Promise<unknown> {
  const { facts, entitlements } = await codesign(scope.installDir);
  const plist = await plistJson(path.join(scope.installDir, "Contents", "Info.plist"));
  const ats = plist?.NSAppTransportSecurity as Obj | undefined;
  const binaries: Obj[] = [];
  const seen = new Set<string>();
  for (const proc of scope.procs.slice(0, 12)) {
    if (!proc.path || seen.has(proc.path)) continue;
    seen.add(proc.path);
    const header = await machO(proc.path);
    binaries.push({
      path: proc.path,
      pie: header?.pie ?? "unknown",
      ...(header?.allowStackExecution ? { allowsStackExecution: true } : {}),
    });
  }
  return {
    hardenedRuntime: facts.hardenedRuntime ?? false,
    sandboxed: entitlements["com.apple.security.app-sandbox"] === true,
    weakeningEntitlements: Object.entries(WEAK_ENTITLEMENTS)
      .filter(([key]) => entitlements[key] === true)
      .map(([key, why]) => `${key}: ${why}`),
    appTransportSecurity: ats
      ? {
          allowsArbitraryLoads: ats.NSAllowsArbitraryLoads === true,
          allowsLocalNetworking: ats.NSAllowsLocalNetworking === true,
          exceptionDomains: Object.keys((ats.NSExceptionDomains as Obj | undefined) ?? {}).slice(
            0,
            20,
          ),
        }
      : "default (HTTPS required)",
    binaries,
  };
}

const SYSTEM_PATHS = [
  "/System/",
  "/usr/lib/",
  "/usr/libexec/",
  "/Library/Apple/",
  "/System/Volumes/Preboot/",
];

function groupOrWorldWritable(mode: number): boolean {
  return (mode & 0o022) !== 0;
}

async function sectionModules(scope: Scope): Promise<unknown> {
  const rows: Obj[] = [];
  const planting: string[] = [];
  let total = 0;
  const seen = new Set<string>();
  for (const proc of scope.procs.slice(0, 8)) {
    const { out } = await run("/usr/sbin/lsof", ["-a", "-p", String(proc.pid), "-d", "txt", "-Fn"]);
    for (const line of out.split("\n")) {
      if (!line.startsWith("n/")) continue;
      const file = line.slice(1);
      total += 1;
      if (seen.has(file) || SYSTEM_PATHS.some((prefix) => file.startsWith(prefix))) continue;
      seen.add(file);
      // lsof also lists memory-mapped data files; only Mach-O images load code.
      if ((await machO(file)) === null) continue;
      const inBundle = file.startsWith(`${scope.installDir}/`);
      let writable = false;
      try {
        const stat = await fs.stat(path.dirname(file));
        writable = groupOrWorldWritable(stat.mode);
      } catch {
        // unreadable: not reported as writable
      }
      if (writable) planting.push(path.dirname(file));
      if (rows.length < 400) {
        rows.push({
          pid: proc.pid,
          path: file,
          location: inBundle ? "bundle" : "outside the bundle",
          dirWritableByOthers: writable,
        });
      }
    }
  }
  return {
    total,
    shown: rows.length,
    nonSystemModules: seen.size,
    writableDirsThatLoadCode: [...new Set(planting)],
    modules: rows.sort((a, b) => Number(a.location === "bundle") - Number(b.location === "bundle")),
  };
}

function bindOf(address: string): "loopback" | "any" | "lan" {
  if (address === "127.0.0.1" || address === "::1" || address.startsWith("127.")) return "loopback";
  if (address === "*" || address === "0.0.0.0" || address === "::") return "any";
  return "lan";
}

interface SocketRow {
  proto: string;
  pid: number;
  local: { address: string; port: number } | null;
  remote: { address: string; port: number } | null;
  state: string;
}

function hostPort(value: string): { address: string; port: number } | null {
  const at = value.lastIndexOf(":");
  if (at < 0) return null;
  const port = Number(value.slice(at + 1));
  if (!Number.isInteger(port)) return null;
  return { address: value.slice(0, at).replace(/^\[|\]$/g, ""), port };
}

// lsof -F: "p<pid>" starts a process, "f" a descriptor, then "P" protocol, "n" name, "TST=" state.
async function socketRows(pids: number[]): Promise<SocketRow[]> {
  const { out } = await run("/usr/sbin/lsof", [
    "-nP",
    "-iTCP",
    "-iUDP",
    "-a",
    "-p",
    pids.join(","),
    "-F",
    "pPnT",
  ]);
  const rows: SocketRow[] = [];
  let pid = 0;
  let cur: SocketRow | null = null;
  const flush = () => {
    if (cur?.local) rows.push(cur);
    cur = null;
  };
  for (const line of out.split("\n")) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      flush();
      pid = Number(value);
    } else if (tag === "f") {
      flush();
      cur = { proto: "tcp", pid, local: null, remote: null, state: "" };
    } else if (!cur) {
      continue;
    } else if (tag === "P") {
      cur.proto = value.toLowerCase();
    } else if (tag === "n") {
      const [left = "", right] = value.split("->");
      cur.local = hostPort(left);
      cur.remote = right ? hostPort(right) : null;
    } else if (tag === "T" && value.startsWith("ST=")) {
      cur.state = value.slice(3);
    }
  }
  flush();
  return rows;
}

function listenerRow(row: SocketRow): Obj | null {
  if (!row.local || row.remote) return null;
  if (row.proto === "tcp" && row.state !== "LISTEN") return null;
  const bind = bindOf(row.local.address);
  return {
    proto: row.proto,
    address: row.local.address,
    port: row.local.port,
    pid: row.pid,
    bind,
    reachableOffBox: bind !== "loopback",
  };
}

async function sectionPorts(scope: Scope): Promise<unknown> {
  const rows = await socketRows(scope.procs.map((p) => p.pid));
  const listening = rows.map(listenerRow).filter((row): row is Obj => row !== null);
  const connections = rows
    .filter((row) => row.local && row.remote)
    .slice(0, 150)
    .map((row) => ({
      proto: row.proto,
      local: `${row.local?.address}:${row.local?.port}`,
      remote: `${row.remote?.address}:${row.remote?.port}`,
      state: row.state || "ESTABLISHED",
      pid: row.pid,
    }));
  return { listening, connections };
}

async function sectionChildren(scope: Scope): Promise<unknown> {
  const others = scope.procs.filter((p) => p.pid !== scope.pid).slice(0, 40);
  const args = await argsOf(others.map((p) => p.pid));
  return others.map((p) => ({
    pid: p.pid,
    parent: p.ppid,
    path: p.path,
    inScope: true,
    commandline: outline(p.path, args.get(p.pid)),
  }));
}

async function sectionCommandline(scope: Scope): Promise<unknown> {
  const args = await argsOf([scope.pid]);
  return outline(scope.exe, args.get(scope.pid));
}

async function sectionProtocols(scope: Scope): Promise<unknown> {
  const plist = await plistJson(path.join(scope.installDir, "Contents", "Info.plist"));
  const types = Array.isArray(plist?.CFBundleURLTypes) ? (plist.CFBundleURLTypes as Obj[]) : [];
  const out: Obj[] = [];
  for (const type of types) {
    const schemes = Array.isArray(type.CFBundleURLSchemes)
      ? (type.CFBundleURLSchemes as string[])
      : [];
    for (const scheme of schemes) {
      const handler = scope.handlers[scheme];
      out.push({
        scheme,
        name: typeof type.CFBundleURLName === "string" ? type.CFBundleURLName : "",
        defaultHandler: handler ? path.basename(handler) : "none",
        isThisApp: handler === scope.installDir,
      });
    }
  }
  return out;
}

const MAX_WALK = 6000;

interface Dir {
  path: string;
  kind: string;
}

async function sectionAcls(scope: Scope, input: SecurityInput): Promise<unknown> {
  const dirs: Dir[] = [
    { path: scope.installDir, kind: "install" },
    ...input.guard.dataDirs.map((dir) => ({ path: dir, kind: "data" })),
  ];
  const me = os.userInfo().uid;
  const reports: Obj[] = [];
  for (const dir of dirs) {
    const writable: string[] = [];
    let visited = 0;
    const walk = async (current: string, depth: number): Promise<void> => {
      if (visited >= MAX_WALK || depth > 8) return;
      let names: string[];
      try {
        names = await fs.readdir(current);
      } catch {
        return;
      }
      for (const name of names) {
        if (visited >= MAX_WALK) return;
        visited += 1;
        const full = path.join(current, name);
        try {
          const stat = await fs.lstat(full);
          if (stat.isSymbolicLink()) continue;
          if (groupOrWorldWritable(stat.mode) && writable.length < 30) {
            writable.push(`${path.relative(dir.path, full)} (${(stat.mode & 0o777).toString(8)})`);
          }
          if (stat.isDirectory()) await walk(full, depth + 1);
        } catch {
          // vanished or unreadable
        }
      }
    };
    let owner = "unknown";
    let mode = "";
    try {
      const stat = await fs.stat(dir.path);
      owner = ownerName(stat.uid, me);
      mode = (stat.mode & 0o777).toString(8);
    } catch {
      // gone
    }
    await walk(dir.path, 0);
    const report: Obj = {
      kind: dir.kind,
      path: dir.path,
      owner,
      mode,
      entriesChecked: visited,
      truncated: visited >= MAX_WALK,
      groupOrWorldWritable: writable,
    };
    if (dir.kind === "install") {
      const quarantine = await run("/usr/bin/xattr", ["-p", "com.apple.quarantine", dir.path]);
      report.quarantine = quarantine.code === 0 ? quarantine.out.trim() : "none";
    }
    reports.push(report);
  }
  return reports;
}

const FUSE_NAMES = [
  "RunAsNode",
  "EnableCookieEncryption",
  "EnableNodeOptionsEnvironmentVariable",
  "EnableNodeCliInspectArguments",
  "EnableEmbeddedAsarIntegrityValidation",
  "OnlyLoadAppFromAsar",
  "LoadBrowserProcessSpecificV8Snapshot",
  "GrantFileProtocolExtraPrivileges",
];
const FUSE_SENTINEL = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX", "ascii");
const MAX_FUSE_SCAN = 400 * 1024 * 1024;

// The fuse wire after the sentinel: version 1, a length, then one '0', '1' or 'r' per fuse.
function parseFuses(view: Buffer, head: number): Obj | null {
  if (head + 2 > view.length || view[head] !== 1) return null;
  const length = view[head + 1] ?? 0;
  const wire = view.subarray(head + 2, head + 2 + length);
  const valid = length >= 1 && length <= 32 && wire.length === length;
  if (!valid || !wire.every((b) => b === 0x30 || b === 0x31 || b === 0x72)) return null;
  const fuses: Obj = { wireVersion: 1 };
  wire.forEach((byte, i) => {
    fuses[FUSE_NAMES[i] ?? `fuse${i}`] = fuseState(byte);
  });
  return fuses;
}

// The sentinel is followed by a version byte, a length byte, and one '0', '1' or 'r' per fuse.
async function findFuses(file: string): Promise<Obj | null> {
  let handle;
  try {
    handle = await fs.open(file, "r");
    const { size } = await handle.stat();
    const chunk = Buffer.alloc(4 << 20);
    const keep = FUSE_SENTINEL.length + 40;
    let position = 0;
    let carry = 0;
    while (position < Math.min(size, MAX_FUSE_SCAN)) {
      const { bytesRead } = await handle.read(chunk, carry, chunk.length - carry, position);
      if (bytesRead === 0) break;
      const view = chunk.subarray(0, carry + bytesRead);
      let at = view.indexOf(FUSE_SENTINEL);
      while (at >= 0) {
        const fuses = parseFuses(view, at + FUSE_SENTINEL.length);
        if (fuses) return fuses;
        at = view.indexOf(FUSE_SENTINEL, at + 1);
      }
      position += bytesRead;
      carry = Math.min(keep, view.length);
      view.copy(chunk, 0, view.length - carry, view.length);
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

async function sectionElectron(scope: Scope): Promise<unknown> {
  const frameworks = path.join(scope.installDir, "Contents", "Frameworks");
  const framework = path.join(frameworks, "Electron Framework.framework", "Electron Framework");
  let present = true;
  try {
    await fs.stat(framework);
  } catch {
    present = false;
  }
  if (!present) return { isElectron: false };
  const resources = path.join(scope.installDir, "Contents", "Resources");
  const asar = await fs.stat(path.join(resources, "app.asar")).then(
    () => true,
    () => false,
  );
  const appDir = await fs.stat(path.join(resources, "app")).then(
    (s) => s.isDirectory(),
    () => false,
  );
  const fuses = await findFuses(framework);
  const info = await plistJson(path.join(scope.installDir, "Contents", "Info.plist"));
  const frameworkInfo = await plistJson(
    path.join(frameworks, "Electron Framework.framework", "Resources", "Info.plist"),
  );
  const integrity = info?.ElectronAsarIntegrity;
  const observations: string[] = [];
  if (fuses) {
    if (fuses.RunAsNode === "enabled") {
      observations.push(
        "RunAsNode enabled: the signed binary can be run as a Node interpreter (ELECTRON_RUN_AS_NODE)",
      );
    }
    if (fuses.EnableNodeCliInspectArguments === "enabled") {
      observations.push(
        "EnableNodeCliInspectArguments enabled: --inspect works on the production binary",
      );
    }
    if (fuses.EnableNodeOptionsEnvironmentVariable === "enabled") {
      observations.push("EnableNodeOptionsEnvironmentVariable enabled: NODE_OPTIONS is honoured");
    }
    if (fuses.OnlyLoadAppFromAsar === "disabled") {
      observations.push(
        "OnlyLoadAppFromAsar disabled: an app folder beside the asar can replace the app",
      );
    }
    if (fuses.EnableEmbeddedAsarIntegrityValidation === "disabled") {
      observations.push(
        "EmbeddedAsarIntegrityValidation disabled: app.asar can be swapped without detection",
      );
    }
  }
  if (appDir) observations.push("Resources/app is unpacked source rather than an asar");
  return {
    isElectron: true,
    appAsarPresent: asar,
    "unpackedAppDir(Resources/app)": appDir,
    asarIntegrityInInfoPlist: integrity !== undefined,
    fuses: fuses ?? "fuse wire not found (older Electron or stripped)",
    versions: {
      electronFramework: frameworkInfo?.CFBundleVersion ?? "unknown",
      app: info?.CFBundleShortVersionString ?? "unknown",
    },
    observations,
  };
}

const ALL_SECTIONS = [
  "process",
  "signature",
  "mitigations",
  "modules",
  "ports",
  "children",
  "commandline",
  "protocols",
  "acls",
  "electron",
  "dotnet",
] as const;

type Section = (typeof ALL_SECTIONS)[number];

async function runSection(section: Section, scope: Scope, input: SecurityInput): Promise<unknown> {
  switch (section) {
    case "process":
      return sectionProcess(scope);
    case "signature":
      return sectionSignature(scope);
    case "mitigations":
      return sectionMitigations(scope);
    case "modules":
      return sectionModules(scope);
    case "ports":
      return sectionPorts(scope);
    case "children":
      return sectionChildren(scope);
    case "commandline":
      return sectionCommandline(scope);
    case "protocols":
      return sectionProtocols(scope);
    case "acls":
      return sectionAcls(scope, input);
    case "electron":
      return sectionElectron(scope);
    case "dotnet":
      return { note: "Not applicable on macOS." };
  }
}

/** Certificate-validation signals in the app's Info.plist (App Transport Security exceptions). */
export async function atsSignals(input: SecurityInput): Promise<string[]> {
  const scope = await getScope(input);
  const plist = await plistJson(path.join(scope.installDir, "Contents", "Info.plist"));
  const ats = plist?.NSAppTransportSecurity as Obj | undefined;
  if (!ats) return [];
  const out: string[] = [];
  if (ats.NSAllowsArbitraryLoads === true) {
    out.push(
      "Info.plist sets NSAllowsArbitraryLoads: App Transport Security is off, plain HTTP is allowed.",
    );
  }
  const domains = Object.keys((ats.NSExceptionDomains as Obj | undefined) ?? {});
  if (domains.length > 0) {
    out.push(
      `Info.plist has App Transport Security exception domains: ${domains.slice(0, 5).join(", ")}.`,
    );
  }
  return out;
}

/** One section's structured facts, for the network tool. */
export async function inspectSection(input: SecurityInput, section: string): Promise<Obj> {
  const name = ALL_SECTIONS.find((candidate) => candidate === section);
  if (!name) return {};
  const scope = await getScope(input);
  return { [name]: await runSection(name, scope, input) };
}

export async function runInspect(
  args: Args<"inspect">,
  input: SecurityInput,
): Promise<Extract<DesktopTargetResult, { command: "inspect" }>> {
  const section = args.section ?? "all";
  const scope = await getScope(input);
  if (!scope.installDir) throw new HelperError("failed", "The app's bundle could not be found.");
  const wanted = section === "all" ? ALL_SECTIONS : [section];
  const structured: Obj = {};
  // The sections only read, so `all` runs them side by side and gives each a 4 s budget.
  const results = await Promise.all(
    wanted.map((name) => {
      const work = runSection(name, scope, input).catch((error: unknown) => {
        if (error instanceof HelperError) throw error;
        return { error: error instanceof Error ? error.name : "failed" };
      });
      if (section !== "all") return work;
      const budget = new Promise<Obj>((resolve) =>
        setTimeout(() => resolve({ skipped: "4 s budget used" }), 4000).unref(),
      );
      return Promise.race([work, budget]);
    }),
  );
  wanted.forEach((name, index) => {
    structured[name] = results[index];
  });
  const report = Object.entries(structured)
    .map(([name, value]) => `== ${name} ==\n${fmtText(value)}`)
    .join("\n\n");
  return { command: "inspect", report, structured };
}

// ---- ipc ----

async function launchItems(scope: Scope): Promise<Obj[]> {
  const home = os.homedir();
  const dirs = [
    path.join(home, "Library", "LaunchAgents"),
    "/Library/LaunchAgents",
    "/Library/LaunchDaemons",
  ];
  const found: Obj[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names.filter((n) => n.endsWith(".plist")).slice(0, 400)) {
      const file = path.join(dir, name);
      try {
        const text = await fs.readFile(file, "latin1");
        if (
          text.includes(scope.installDir) ||
          (scope.bundleId && name.startsWith(scope.bundleId))
        ) {
          const stat = await fs.stat(file);
          found.push({
            file,
            mode: (stat.mode & 0o777).toString(8),
            writableByOthers: groupOrWorldWritable(stat.mode),
          });
        }
      } catch {
        // unreadable
      }
    }
  }
  return found;
}

async function privilegedHelpers(scope: Scope): Promise<Obj[]> {
  try {
    const names = await fs.readdir("/Library/PrivilegedHelperTools");
    return names
      .filter((name) => scope.bundleId !== "" && name.startsWith(scope.bundleId))
      .map((name) => ({ path: `/Library/PrivilegedHelperTools/${name}` }));
  } catch {
    return [];
  }
}

async function xpcServices(scope: Scope): Promise<string[]> {
  try {
    return (await fs.readdir(path.join(scope.installDir, "Contents", "XPCServices"))).filter((n) =>
      n.endsWith(".xpc"),
    );
  } catch {
    return [];
  }
}

// Unix sockets and FIFOs held by the tree: lsof -U for sockets, the "FIFO" type for pipes.
async function unixEndpoints(pids: number[]): Promise<{ sockets: Obj[]; fifos: Obj[] }> {
  const { out } = await run("/usr/sbin/lsof", ["-a", "-p", pids.join(","), "-U", "-Fpftn"]);
  const sockets = new Map<string, Obj>();
  let pid = 0;
  let type = "";
  for (const line of out.split("\n")) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") pid = Number(value);
    else if (tag === "t") type = value;
    else if (tag === "n" && value.startsWith("/") && !sockets.has(value)) {
      let mode = "";
      let writable = false;
      try {
        const stat = await fs.stat(value);
        mode = (stat.mode & 0o777).toString(8);
        writable = (stat.mode & 0o002) !== 0;
      } catch {
        // the path is gone
      }
      sockets.set(value, { path: value, pid, type, mode, writableByAnyone: writable });
    }
  }
  const fifoOut = await run("/usr/sbin/lsof", ["-a", "-p", pids.join(","), "-Fpftn"]);
  const fifos = new Map<string, Obj>();
  pid = 0;
  type = "";
  for (const line of fifoOut.out.split("\n")) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") pid = Number(value);
    else if (tag === "t") type = value;
    else if (tag === "n" && type === "FIFO" && value.startsWith("/") && !fifos.has(value)) {
      let writable = false;
      try {
        writable = ((await fs.stat(value)).mode & 0o002) !== 0;
      } catch {
        // gone
      }
      fifos.set(value, { path: value, pid, writableByAnyone: writable });
    }
  }
  return { sockets: [...sockets.values()].slice(0, 100), fifos: [...fifos.values()].slice(0, 100) };
}

function simpleHttp(port: number, pathName: string, host: string): Promise<Obj> {
  return new Promise((resolve) => {
    const started = Date.now();
    const result: Obj = {};
    const chunks: Buffer[] = [];
    let total = 0;
    const socket = net.connect({ host: "127.0.0.1", port });
    const describe = (): Obj => {
      const text = Buffer.concat(chunks).toString("utf8");
      result.bytesRead = total;
      result.capped = total >= 16384;
      if (total === 0) {
        result.response = "connection closed with no data";
        return result;
      }
      const split = text.indexOf("\r\n\r\n");
      const head = split >= 0 ? text.slice(0, split) : text;
      const body = split >= 0 ? text.slice(split + 4) : "";
      const lines = head.split("\r\n");
      result.statusLine = (lines[0] ?? "").slice(0, 120);
      const status = /HTTP\/\d\.\d (\d{3})/.exec(lines[0] ?? "");
      if (status) result.status = Number(status[1]);
      const keep = new Set([
        "server",
        "content-type",
        "access-control-allow-origin",
        "www-authenticate",
        "location",
        "content-length",
        "set-cookie",
      ]);
      result.headers = lines
        .slice(1)
        .map((line) => {
          const at = line.indexOf(":");
          if (at <= 0) return "";
          const key = line.slice(0, at).trim().toLowerCase();
          if (!keep.has(key)) return "";
          return `${key}: ${key === "set-cookie" ? "<present>" : redactValue(key, line.slice(at + 1).trim())}`;
        })
        .filter(Boolean);
      result.bodyLength = body.length;
      result.bodyPreview = body
        .slice(0, 160)
        .replace(/[A-Za-z0-9_\-+/=.]{20,}/g, (m) => `${m.slice(0, 4)}...<len ${m.length}>`)
        // oxlint-disable-next-line no-control-regex
        .replace(/[\x00-\x08\x0B-\x1F]/g, "?");
      return result;
    };
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(describe());
    };
    socket.setTimeout(3000, () => {
      result.error ??= "timeout";
      finish();
    });
    socket.on("error", (error) => {
      result.error = error.name === "Error" ? (error as NodeJS.ErrnoException).code : error.name;
      finish();
    });
    socket.on("connect", () => {
      socket.write(
        `GET ${pathName} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: pimi-security-probe\r\nAccept: */*\r\nConnection: close\r\n\r\n`,
      );
    });
    socket.on("data", (data) => {
      chunks.push(data);
      total += data.length;
      if (total >= 16384 || Date.now() - started > 3000) finish();
    });
    socket.on("end", finish);
  });
}

export async function runIpc(
  args: Args<"ipc">,
  input: SecurityInput,
): Promise<Extract<DesktopTargetResult, { command: "ipc" }>> {
  const probe = args.action === "probe";
  // A probe is input: the helper's scope call enforces the owner's input consent.
  const scope = await getScope(input, probe);
  const pids = scope.procs.map((p) => p.pid);
  const rows = await socketRows(pids);
  if (!probe) {
    const listeners = rows.map(listenerRow).filter((row): row is Obj => row !== null);
    const unix = await unixEndpoints(pids);
    const structured: Obj = {
      listeners,
      unixSockets: unix.sockets,
      fifos: unix.fifos,
      xpcServices: await xpcServices(scope),
      launchItems: await launchItems(scope),
      privilegedHelperTools: await privilegedHelpers(scope),
      note: "Mach ports are not listed.",
    };
    return { command: "ipc", report: fmtText(structured), structured };
  }
  const port = args.port ?? 0;
  const owner = rows.find(
    (row) =>
      row.proto === "tcp" &&
      row.state === "LISTEN" &&
      row.local?.port === port &&
      row.local &&
      bindOf(row.local.address) !== "lan",
  );
  if (!owner || !owner.local) {
    throw new HelperError(
      "refused",
      `No TCP listener on loopback port ${port} is owned by the target's process tree.`,
    );
  }
  const requestPath = args.path ?? "/";
  const normal = await simpleHttp(port, requestPath, `127.0.0.1:${port}`);
  const foreign = await simpleHttp(port, requestPath, "pimi-rebind-check.invalid");
  const accepted =
    typeof foreign.status === "number" && foreign.status >= 200 && foreign.status < 400;
  const structured: Obj = {
    port,
    bind: bindOf(owner.local.address),
    ownerPid: owner.pid,
    normalHost: normal,
    foreignHost: foreign,
    foreignHostAccepted: accepted,
    dnsRebindingRisk: accepted
      ? "the server answered a request whose Host header was not localhost"
      : "foreign Host header was rejected or closed",
  };
  return { command: "ipc", report: fmtText(structured), structured };
}
