import { readdir, readFile, readlink } from "node:fs/promises";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { execFileUnobserved, spawnUnobserved } from "../../utils/process-launch.js";

// What the OS says about processes and sockets, with no privileges. macOS reads `ps` and
// `lsof`; Linux reads /proc; Windows keeps one PowerShell child alive and asks it once per
// tick (starting PowerShell per tick would cost more than the tick). Every external program
// here starts through the unobserved spawn, so the sampler never shows up as a launch.

export interface ProcessRow {
  pid: number;
  ppid: number;
  /** Program name without a directory. */
  name: string;
  rssBytes: number;
  /** Cumulative CPU time (user + system) in milliseconds. */
  cpuMs: number;
}

export interface SocketRow {
  pid: number;
  protocol: "tcp" | "udp";
  localPort: number;
  remoteAddress: string;
  remotePort: number;
  state: string;
}

export interface OsReader {
  /** Why sockets cannot be read on this platform, or null. */
  readonly socketsUnavailable: string | null;
  readProcesses(): Promise<ProcessRow[]>;
  readSockets(pids: readonly number[]): Promise<SocketRow[]>;
  close(): void;
}

const EXEC_TIMEOUT_MS = 15_000;
const MAX_BUFFER = 64 * 1024 * 1024;
// Linux reports CPU in clock ticks; USER_HZ is 100 on every Linux ABI userspace sees.
const LINUX_CLOCK_TICKS_PER_SECOND = 100;

function baseName(value: string): string {
  const cut = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  return cut === -1 ? value : value.slice(cut + 1);
}

/** Parses ps `time`: [[dd-]hh:]mm:ss[.cc] (macOS prints `m:ss.cc`). */
export function parsePsCpuTime(value: string): number {
  let rest = value;
  let days = 0;
  const dash = rest.indexOf("-");
  if (dash !== -1) {
    days = Number(rest.slice(0, dash));
    rest = rest.slice(dash + 1);
  }
  const parts = rest.split(":").map(Number);
  if (parts.some((part) => Number.isNaN(part))) return 0;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return Math.round((days * 86_400 + seconds) * 1000);
}

// ---- macOS ---------------------------------------------------------------------------------

async function readPsProcesses(): Promise<ProcessRow[]> {
  const { stdout } = await execFileUnobserved(
    "ps",
    ["-A", "-ww", "-o", "pid=,ppid=,rss=,time=,comm="],
    { timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_BUFFER, env: { ...process.env, LC_ALL: "C" } },
  );
  const rows: ProcessRow[] = [];
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
      cpuMs: parsePsCpuTime(match[4]),
      name: baseName(match[5]),
    });
  }
  if (rows.length === 0) throw new Error("ps returned no processes");
  return rows;
}

function splitEndpoint(value: string): { address: string; port: number } | null {
  const cut = value.lastIndexOf(":");
  if (cut === -1) return null;
  const port = Number(value.slice(cut + 1));
  if (!Number.isInteger(port)) return null;
  return { address: normalizeAddress(value.slice(0, cut)), port };
}

export function normalizeAddress(value: string): string {
  const bare = value.replace(/^\[|\]$/g, "").toLowerCase();
  const mapped = bare.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? mapped[1]! : bare;
}

const PROTOCOLS: Record<string, "tcp" | "udp"> = { TCP: "tcp", UDP: "udp" };

/** Parses `lsof -F pPnT` output. Listening sockets and unconnected UDP have no peer and are skipped. */
export function parseLsofSockets(stdout: string): SocketRow[] {
  const rows: SocketRow[] = [];
  let pid = 0;
  let protocol: "tcp" | "udp" | null = null;
  let name = "";
  let state = "";
  const finish = (): void => {
    if (protocol && name.includes("->")) {
      const [local, remote] = name.split("->");
      const l = splitEndpoint(local ?? "");
      const r = splitEndpoint(remote ?? "");
      if (l && r) {
        rows.push({
          pid,
          protocol,
          localPort: l.port,
          remoteAddress: r.address,
          remotePort: r.port,
          state: state || (protocol === "udp" ? "CONNECTED" : ""),
        });
      }
    }
    protocol = null;
    name = "";
    state = "";
  };
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      finish();
      pid = Number(value);
    } else if (tag === "P") {
      finish();
      protocol = PROTOCOLS[value] ?? null;
    } else if (tag === "n") {
      name = value;
    } else if (tag === "T" && value.startsWith("ST=")) {
      state = value.slice(3);
    }
  }
  finish();
  return rows;
}

async function readLsofSockets(pids: readonly number[]): Promise<SocketRow[]> {
  if (pids.length === 0) return [];
  try {
    const { stdout } = await execFileUnobserved(
      "lsof",
      ["-nP", "-a", "-p", pids.join(","), "-iTCP", "-iUDP", "-F", "pPnT"],
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
    );
    return parseLsofSockets(stdout);
  } catch (error) {
    // lsof exits 1 when nothing matched, and may exit 1 with partial output when one of the
    // pids vanished mid-run. Anything else is a real failure.
    const failure = error as { code?: unknown; stdout?: unknown };
    if (failure.code === 1) return parseLsofSockets(String(failure.stdout ?? ""));
    throw error;
  }
}

function createMacReader(): OsReader {
  return {
    socketsUnavailable: null,
    readProcesses: readPsProcesses,
    readSockets: readLsofSockets,
    close: () => undefined,
  };
}

// ---- Linux ---------------------------------------------------------------------------------

async function readProcFile(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function readLinuxProcesses(): Promise<ProcessRow[]> {
  const names = await readdir("/proc");
  const rows: ProcessRow[] = [];
  await Promise.all(
    names
      .filter((name) => /^\d+$/.test(name))
      .map(async (name) => {
        const stat = await readProcFile(`/proc/${name}/stat`);
        if (!stat) return;
        // comm is in parentheses and may itself hold spaces and parentheses.
        const open = stat.indexOf("(");
        const close = stat.lastIndexOf(")");
        if (open === -1 || close === -1) return;
        const rest = stat
          .slice(close + 2)
          .trim()
          .split(/\s+/);
        // After comm: state(0) ppid(1) ... utime(11) stime(12).
        const ppid = Number(rest[1]);
        const ticks = Number(rest[11]) + Number(rest[12]);
        if (Number.isNaN(ppid) || Number.isNaN(ticks)) return;
        const status = await readProcFile(`/proc/${name}/status`);
        const rss = status?.match(/^VmRSS:\s+(\d+)\s+kB/m);
        rows.push({
          pid: Number(name),
          ppid,
          name: stat.slice(open + 1, close),
          rssBytes: rss ? Number(rss[1]) * 1024 : 0,
          cpuMs: Math.round((ticks * 1000) / LINUX_CLOCK_TICKS_PER_SECOND),
        });
      }),
  );
  if (rows.length === 0) throw new Error("/proc held no processes");
  return rows;
}

const TCP_STATES: Record<string, string> = {
  "01": "ESTABLISHED",
  "02": "SYN_SENT",
  "03": "SYN_RECV",
  "04": "FIN_WAIT1",
  "05": "FIN_WAIT2",
  "06": "TIME_WAIT",
  "07": "CLOSE",
  "08": "CLOSE_WAIT",
  "09": "LAST_ACK",
  "0A": "LISTEN",
  "0B": "CLOSING",
};

/** /proc/net hex address: IPv4 is one little-endian word, IPv6 four of them. */
export function parseProcNetAddress(hex: string): string {
  const words = hex.match(/.{8}/g) ?? [];
  const bytes: number[] = [];
  for (const word of words) {
    for (let at = 6; at >= 0; at -= 2) bytes.push(Number.parseInt(word.slice(at, at + 2), 16));
  }
  if (bytes.length === 4) return bytes.join(".");
  const groups: string[] = [];
  for (let at = 0; at < 16; at += 2) groups.push(((bytes[at]! << 8) | bytes[at + 1]!).toString(16));
  return normalizeAddress(groups.join(":").replace(/(^|:)(0(:|$)){2,}/, "::"));
}

async function readLinuxSockets(pids: readonly number[]): Promise<SocketRow[]> {
  const owners = new Map<string, number>();
  await Promise.all(
    pids.map(async (pid) => {
      let fds: string[];
      try {
        fds = await readdir(`/proc/${pid}/fd`);
      } catch {
        return;
      }
      await Promise.all(
        fds.map(async (fd) => {
          try {
            const target = await readlink(`/proc/${pid}/fd/${fd}`);
            const inode = target.match(/^socket:\[(\d+)\]$/);
            if (inode) owners.set(inode[1]!, pid);
          } catch {
            // The descriptor closed while the table was read.
          }
        }),
      );
    }),
  );
  if (owners.size === 0) return [];
  const rows: SocketRow[] = [];
  for (const [file, protocol] of [
    ["tcp", "tcp"],
    ["tcp6", "tcp"],
    ["udp", "udp"],
    ["udp6", "udp"],
  ] as const) {
    const text = await readProcFile(`/proc/net/${file}`);
    if (!text) continue;
    for (const line of text.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10) continue;
      const pid = owners.get(cols[9]!);
      if (pid === undefined) continue;
      const [localHex, localPort] = cols[1]!.split(":");
      const [remoteHex, remotePort] = cols[2]!.split(":");
      if (!localHex || !remoteHex || !localPort || !remotePort) continue;
      const remotePortNumber = Number.parseInt(remotePort, 16);
      const state = protocol === "tcp" ? (TCP_STATES[cols[3]!.toUpperCase()] ?? cols[3]!) : "";
      if (state === "LISTEN" || state === "TIME_WAIT" || state === "CLOSE") continue;
      if (remotePortNumber === 0) continue;
      rows.push({
        pid,
        protocol,
        localPort: Number.parseInt(localPort, 16),
        remoteAddress: parseProcNetAddress(remoteHex),
        remotePort: remotePortNumber,
        state: state || "CONNECTED",
      });
    }
  }
  return rows;
}

function createLinuxReader(): OsReader {
  return {
    socketsUnavailable: null,
    readProcesses: readLinuxProcesses,
    readSockets: readLinuxSockets,
    close: () => undefined,
  };
}

// ---- Windows -------------------------------------------------------------------------------

// One request line in, one JSON line out. "p" asks for processes, "s" for processes and TCP
// connections. KernelModeTime and UserModeTime are 100 ns units.
const POWERSHELL_LOOP = `
$ErrorActionPreference = 'SilentlyContinue'
while (($mode = [Console]::In.ReadLine()) -ne $null) {
  $procs = @(Get-CimInstance Win32_Process | ForEach-Object { @{ p = [int]$_.ProcessId; pp = [int]$_.ParentProcessId; n = [string]$_.Name; w = [int64]$_.WorkingSetSize; c = [int64]($_.KernelModeTime + $_.UserModeTime) } })
  $conns = @()
  if ($mode -eq 's') {
    $conns = @(Get-NetTCPConnection | Where-Object { $_.State -ne 'Listen' -and $_.State -ne 'Bound' -and $_.RemotePort -ne 0 } | ForEach-Object { @{ p = [int]$_.OwningProcess; l = [int]$_.LocalPort; a = [string]$_.RemoteAddress; r = [int]$_.RemotePort; s = [string]$_.State } })
  }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject @{ procs = $procs; conns = $conns } -Compress -Depth 4))
  [Console]::Out.Flush()
}
`;

interface WindowsReply {
  procs: Array<{ p: number; pp: number; n: string; w: number; c: number }>;
  conns: Array<{ p: number; l: number; a: string; r: number; s: string }>;
}

class WindowsPowerShellReader implements OsReader {
  readonly socketsUnavailable: string | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private waiting: Array<{
    resolve: (reply: WindowsReply) => void;
    reject: (error: Error) => void;
  }> = [];
  private queue: Promise<unknown> = Promise.resolve();

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = spawnUnobserved(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-NoLogo", "-Command", POWERSHELL_LOOP],
      { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
    ) as ChildProcessWithoutNullStreams;
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const next = this.waiting.shift();
      if (!next) return;
      try {
        next.resolve(JSON.parse(line) as WindowsReply);
      } catch (error) {
        next.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    const fail = (error: Error): void => {
      if (this.child === child) this.child = null;
      for (const next of this.waiting.splice(0)) next.reject(error);
    };
    child.once("error", fail);
    child.once("exit", () => fail(new Error("PowerShell sampler exited")));
    return child;
  }

  private ask(mode: "p" | "s"): Promise<WindowsReply> {
    const run = (): Promise<WindowsReply> =>
      new Promise<WindowsReply>((resolve, reject) => {
        const child = this.ensure();
        const timer = setTimeout(() => {
          reject(new Error("PowerShell sampler timed out"));
          child.kill();
        }, EXEC_TIMEOUT_MS);
        this.waiting.push({
          resolve: (reply) => {
            clearTimeout(timer);
            resolve(reply);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        child.stdin.write(`${mode}\n`);
      });
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async readProcesses(): Promise<ProcessRow[]> {
    const reply = await this.ask("p");
    return reply.procs.map((entry) => ({
      pid: entry.p,
      ppid: entry.pp,
      name: entry.n,
      rssBytes: entry.w,
      cpuMs: Math.round(entry.c / 10_000),
    }));
  }

  async readSockets(pids: readonly number[]): Promise<SocketRow[]> {
    const wanted = new Set(pids);
    const reply = await this.ask("s");
    return reply.conns
      .filter((entry) => wanted.has(entry.p))
      .map((entry) => ({
        pid: entry.p,
        protocol: "tcp" as const,
        localPort: entry.l,
        remoteAddress: normalizeAddress(entry.a),
        remotePort: entry.r,
        state: entry.s.toUpperCase(),
      }));
  }

  close(): void {
    this.child?.kill();
    this.child = null;
  }
}

export function createOsReader(platform: NodeJS.Platform = process.platform): OsReader {
  if (platform === "win32") return new WindowsPowerShellReader();
  if (platform === "linux") return createLinuxReader();
  return createMacReader();
}
