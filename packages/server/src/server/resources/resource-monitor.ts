import dns from "node:dns";
import {
  classifyNetworkHost,
  knownResolveHosts,
  NETWORK_PURPOSE,
} from "@pimi/protocol/network-activity";
import type {
  NetworkActivityRequest,
  ResourceDestination,
  ResourceProcess,
} from "@pimi/protocol/messages";
import { listTerminalWorkerRecords } from "../../terminal/terminal-worker-record.js";
import { createOsReader, type OsReader, type ProcessRow, type SocketRow } from "./os-reader.js";
import { ReverseNames } from "./reverse-dns.js";
import { baselineKey, isIpOnly, NetworkBaseline, type BaselineEntry } from "./network-baseline.js";

// The Resources tab's source of truth: one poller over the OS process and socket tables, rooted
// at the trees Pimi owns (supervisor and daemon, terminal workers and their programs, and the
// desktop app when it asks). It sees every program by pid, in any language, but only what is
// open when a sample runs: a connection shorter than the interval is missed. Hostnames of
// children are not visible; an address is named only from this daemon's own DNS results, its own
// sockets, and a forward lookup of the known hosts. Reverse DNS runs only when a snapshot asks for names.
//
// Anything that wants these numbers (a memory watchdog, say) subscribes with `subscribe` and
// gets each sample; policy lives with the subscriber, not here.

const IDLE_MS = 10_000;
const ACTIVE_SOCKET_MS = 3_000;
const OPEN_MS = 2_000;
const BURST_MS = 250;
const BURST_WINDOW_MS = 3_000;
const LEASE_MS = 6_000;
const WINDOWS_FLOOR_MS = 5_000;
const WORKER_RECORD_REFRESH_MS = 5_000;
const MAX_LAUNCHES = 5_000;
const MAX_ADDRESS_NAMES = 4_000;
const NAME_TTL_MS = 30 * 60_000;
const RESOLVE_INTERVAL_MS = 10 * 60_000;
const HOOK_SEEN_MS = 60_000;
const MAX_DESTINATIONS = 400;
const SAMPLER_HELPERS = new Set(["ps", "lsof", "powershell.exe"]);
const IGNORED_STATES = new Set(["LISTEN", "TIME_WAIT", "CLOSE", "CLOSED", "BOUND"]);

export interface LaunchedProgram {
  program: string;
  purpose: string;
  agentId: string | null;
  atMs: number;
}

export interface TrackedProcess extends ResourceProcess {
  program: string;
}

export interface ResourceSample {
  atMs: number;
  processes: TrackedProcess[];
}

export interface ResourceMonitorOptions {
  home: string;
  /** Called with each new connection, as a log record. */
  onRecord: (record: NetworkActivityRequest) => void;
  onError: (error: unknown, message: string) => void;
  reader?: OsReader;
  platform?: NodeJS.Platform;
}

interface Connection {
  pid: number;
  /** The baseline entry this connection counts toward. */
  key: string;
}

interface ProcessOwner {
  purpose: string | null;
  agentId: string | null;
}

interface TerminalRoots {
  workerPids: Set<number>;
  programs: Map<number, string>;
}

function roleOf(input: {
  pid: number;
  section: ResourceProcess["section"];
  supervisorPid: number | null;
  terminals: TerminalRoots;
}): ResourceProcess["role"] {
  if (input.section === "app") return "app";
  if (input.pid === process.pid) return "daemon";
  if (input.pid === input.supervisorPid) return "supervisor";
  if (input.terminals.workerPids.has(input.pid)) return "terminal-worker";
  if (input.terminals.programs.has(input.pid)) return "terminal";
  return "process";
}

// Taken before the network hooks wrap node:dns, so resolving the known hosts never logs itself.
const lookupUnobserved = dns.promises.lookup.bind(dns.promises);

export class ResourceMonitor {
  readonly baseline: NetworkBaseline;
  private readonly reader: OsReader;
  private readonly platform: NodeJS.Platform;
  private readonly launches = new Map<number, LaunchedProgram>();
  private readonly addressNames = new Map<string, { name: string; atMs: number }>();
  private readonly hookSeen = new Map<string, number>();
  private readonly cpuHistory = new Map<number, { cpuMs: number; atMs: number }>();
  private readonly connections = new Map<string, Connection>();
  private readonly listeners = new Set<(sample: ResourceSample) => void>();
  private readonly resolved = new Map<string, number>();
  private readonly reverseNames = new ReverseNames();
  private tracked: TrackedProcess[] = [];
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;
  private leaseUntilMs = 0;
  private burstUntilMs = 0;
  private appRootPid: number | null = null;
  private lastProcessesAtMs = 0;
  private terminalRoots: TerminalRoots = { workerPids: new Set(), programs: new Map() };
  private terminalRootsAtMs = 0;
  private sequence = 0;
  private lastErrorMessage = "";
  private sampledAtMs = 0;

  constructor(private readonly options: ResourceMonitorOptions) {
    this.platform = options.platform ?? process.platform;
    this.reader = options.reader ?? createOsReader(this.platform);
    this.baseline = new NetworkBaseline(options.home, options.onError);
  }

  // ---- inputs ---------------------------------------------------------------------------

  /** A launch the daemon made: names the pid's purpose and agent, and starts a quick burst. */
  noteLaunch(pid: number, launch: Omit<LaunchedProgram, "atMs">): void {
    const atMs = Date.now();
    this.launches.set(pid, { ...launch, atMs });
    if (this.launches.size > MAX_LAUNCHES) {
      const oldest = this.launches.keys().next().value;
      if (oldest !== undefined) this.launches.delete(oldest);
    }
    this.burstUntilMs = atMs + BURST_WINDOW_MS;
    this.reschedule(BURST_MS);
  }

  /** Names an IP, from this process's own DNS results or sockets. */
  noteResolved(name: string, addresses: readonly string[]): void {
    const normalized = name.trim().toLowerCase().replace(/\.$/, "");
    if (!normalized || /^[\d.]+$/.test(normalized) || normalized.includes(":")) return;
    const atMs = Date.now();
    for (const address of addresses) {
      this.addressNames.delete(address);
      this.addressNames.set(address, { name: normalized, atMs });
    }
    while (this.addressNames.size > MAX_ADDRESS_NAMES) {
      const oldest = this.addressNames.keys().next().value;
      if (oldest === undefined) break;
      this.addressNames.delete(oldest);
    }
  }

  /** A connection this process's own hooks already recorded, so the sampler does not log it twice. */
  noteHookConnection(address: string, port: number): void {
    this.hookSeen.set(`${address}:${port}`, Date.now());
    if (this.hookSeen.size > 2_000) {
      const oldest = this.hookSeen.keys().next().value;
      if (oldest !== undefined) this.hookSeen.delete(oldest);
    }
  }

  /** The Resources tab is open: sample fast for a few seconds. */
  touchLease(appRootPid: number | null): void {
    const wasOpen = Date.now() < this.leaseUntilMs;
    this.leaseUntilMs = Date.now() + LEASE_MS;
    const appChanged = appRootPid !== this.appRootPid;
    this.appRootPid = appRootPid;
    if (!wasOpen || appChanged) this.reschedule(0);
  }

  subscribe(listener: (sample: ResourceSample) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- lifecycle ------------------------------------------------------------------------

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.reschedule(2_000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.reader.close();
    await this.baseline.save();
  }

  private reschedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const floor = this.platform === "win32" ? WINDOWS_FLOOR_MS : 0;
    this.timer = setTimeout(() => void this.run(), Math.max(delayMs, delayMs === 0 ? 0 : floor));
    this.timer.unref();
  }

  private isOpen(now: number): boolean {
    return now < this.leaseUntilMs;
  }

  private isActive(): boolean {
    return this.tracked.some((entry) => entry.role === "process" && entry.section !== "app");
  }

  private nextDelay(now: number): number {
    if (now < this.burstUntilMs) return BURST_MS;
    if (this.isOpen(now)) return OPEN_MS;
    if (this.isActive()) return ACTIVE_SOCKET_MS;
    return IDLE_MS;
  }

  private processInterval(now: number): number {
    return this.isOpen(now) ? OPEN_MS : IDLE_MS;
  }

  private async run(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    const startedAt = Date.now();
    try {
      await this.tick(startedAt);
      this.lastErrorMessage = "";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== this.lastErrorMessage) {
        this.lastErrorMessage = message;
        this.options.onError(error, "The resource sampler could not read the process table");
      }
    } finally {
      this.running = false;
      const now = Date.now();
      this.reschedule(this.nextDelay(now));
    }
  }

  // ---- sampling -------------------------------------------------------------------------

  private async tick(now: number): Promise<void> {
    await this.baseline.ready;
    const needProcesses =
      this.tracked.length === 0 || now - this.lastProcessesAtMs >= this.processInterval(now) - 50;
    if (needProcesses) await this.sampleProcesses(now);
    await this.sampleSockets(now);
    this.sampledAtMs = Date.now();
    if (needProcesses) {
      const sample: ResourceSample = { atMs: now, processes: this.tracked };
      for (const listener of this.listeners) {
        try {
          listener(sample);
        } catch (error) {
          this.options.onError(error, "A resource sample subscriber failed");
        }
      }
    }
    this.pruneNames(now);
    this.resolveKnownHosts(now);
  }

  private async readTerminalRoots(now: number): Promise<TerminalRoots> {
    if (now - this.terminalRootsAtMs < WORKER_RECORD_REFRESH_MS) return this.terminalRoots;
    this.terminalRootsAtMs = now;
    const roots: TerminalRoots = { workerPids: new Set(), programs: new Map() };
    try {
      for (const file of await listTerminalWorkerRecords(this.options.home)) {
        if ("error" in file) continue;
        roots.workerPids.add(file.record.pid);
        for (const terminal of file.record.terminals) roots.programs.set(terminal.pid, terminal.id);
      }
    } catch (error) {
      this.options.onError(error, "Could not read the terminal worker records");
    }
    this.terminalRoots = roots;
    return roots;
  }

  private async sampleProcesses(now: number): Promise<void> {
    const rows = await this.reader.readProcesses();
    const terminals = await this.readTerminalRoots(now);
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    // The sampler's own ps and lsof children, and processes already dead, are not the owner's.
    const noise = (row: ProcessRow): boolean =>
      row.name.startsWith("<defunct>") ||
      (row.ppid === process.pid && SAMPLER_HELPERS.has(row.name.toLowerCase()));
    const supervisorPid = typeof process.send === "function" ? process.ppid : null;
    const claimed = this.claimTrees(rows, terminals, supervisorPid);
    const owners = new Map<number, ProcessOwner>();
    const tracked: TrackedProcess[] = [];
    for (const [pid, section] of claimed) {
      const row = byPid.get(pid)!;
      if (noise(row)) continue;
      const owner = this.ownerOf(pid, byPid, claimed, owners);
      const launch = this.launches.get(pid);
      const role = roleOf({ pid, section, supervisorPid, terminals });
      tracked.push({
        pid,
        ppid: row.ppid,
        name: row.name,
        program: role === "daemon" ? "daemon" : (launch?.program ?? row.name),
        section,
        role,
        purpose: owner.purpose,
        agentId: owner.agentId,
        terminalId: terminals.programs.get(pid) ?? null,
        cpuPercent: this.cpuPercent(row, now),
        rssBytes: row.rssBytes,
        connections: 0,
        newDestinations: 0,
      });
    }
    for (const pid of this.cpuHistory.keys()) if (!byPid.has(pid)) this.cpuHistory.delete(pid);
    for (const [pid, launch] of this.launches) {
      if (!byPid.has(pid) && now - launch.atMs > 60_000) this.launches.delete(pid);
    }
    this.tracked = tracked;
    this.lastProcessesAtMs = now;
  }

  /** CPU use since the previous sample of the same pid; null on the first sight. */
  private cpuPercent(row: ProcessRow, now: number): number | null {
    const previous = this.cpuHistory.get(row.pid);
    this.cpuHistory.set(row.pid, { cpuMs: row.cpuMs, atMs: now });
    if (!previous || now <= previous.atMs || row.cpuMs < previous.cpuMs) return null;
    return ((row.cpuMs - previous.cpuMs) / (now - previous.atMs)) * 100;
  }

  /**
   * Assigns every process below a root to one section. Terminal workers and the app are claimed
   * before the daemon: a worker is spawned by the daemon and would otherwise be counted under it.
   */
  private claimTrees(
    rows: readonly ProcessRow[],
    terminals: TerminalRoots,
    supervisorPid: number | null,
  ): Map<number, ResourceProcess["section"]> {
    const present = new Set(rows.map((row) => row.pid));
    const children = new Map<number, number[]>();
    for (const row of rows) {
      const list = children.get(row.ppid) ?? [];
      list.push(row.pid);
      children.set(row.ppid, list);
    }
    const claimed = new Map<number, ResourceProcess["section"]>();
    const claim = (root: number, section: ResourceProcess["section"]): void => {
      if (!present.has(root) || claimed.has(root)) return;
      const queue = [root];
      claimed.set(root, section);
      while (queue.length > 0) {
        for (const child of children.get(queue.shift()!) ?? []) {
          if (claimed.has(child)) continue;
          claimed.set(child, section);
          queue.push(child);
        }
      }
    };
    for (const pid of terminals.workerPids) claim(pid, "terminals");
    // The desktop app spawns the daemon, so the daemon's tree is claimed before the app's.
    if (supervisorPid !== null) claim(supervisorPid, "daemon");
    claim(process.pid, "daemon");
    if (this.appRootPid !== null) claim(this.appRootPid, "app");
    return claimed;
  }

  /** A launch's purpose and agent flow down to everything it started, within one section. */
  private ownerOf(
    pid: number,
    byPid: ReadonlyMap<number, ProcessRow>,
    claimed: ReadonlyMap<number, ResourceProcess["section"]>,
    cache: Map<number, ProcessOwner>,
  ): ProcessOwner {
    const known = cache.get(pid);
    if (known) return known;
    const launch = this.launches.get(pid);
    const row = byPid.get(pid);
    let owner: ProcessOwner = {
      purpose: launch?.purpose ?? null,
      agentId: launch?.agentId ?? null,
    };
    if (!launch && row && claimed.get(row.ppid) === claimed.get(pid)) {
      owner = this.ownerOf(row.ppid, byPid, claimed, cache);
    }
    cache.set(pid, owner);
    return owner;
  }

  private addressName(address: string, now: number): string | null {
    const entry = this.addressNames.get(address);
    if (!entry || now - entry.atMs > NAME_TTL_MS) return null;
    return entry.name;
  }

  private async sampleSockets(now: number): Promise<void> {
    const pids = new Set(this.tracked.map((entry) => entry.pid));
    // A program launched a moment ago may not be in the last process table yet.
    for (const [pid, launch] of this.launches) {
      if (now - launch.atMs < BURST_WINDOW_MS + 2_000) pids.add(pid);
    }
    const sockets = await this.reader.readSockets([...pids]);
    const byPid = new Map(this.tracked.map((entry) => [entry.pid, entry]));
    const seen = new Set<string>();
    for (const socket of sockets) {
      if (IGNORED_STATES.has(socket.state)) continue;
      if (classifyNetworkHost(socket.remoteAddress).local) continue;
      this.observeSocket(socket, byPid.get(socket.pid) ?? null, now, seen);
    }
    for (const ident of this.connections.keys()) {
      if (!seen.has(ident)) this.connections.delete(ident);
    }
    const counts = new Map<number, { open: number; fresh: number }>();
    for (const connection of this.connections.values()) {
      const entry = this.baseline.get(connection.key);
      const count = counts.get(connection.pid) ?? { open: 0, fresh: 0 };
      count.open += 1;
      if (entry && !this.baseline.isKnown(entry)) count.fresh += 1;
      counts.set(connection.pid, count);
    }
    for (const entry of this.tracked) {
      const count = counts.get(entry.pid);
      entry.connections = count?.open ?? 0;
      entry.newDestinations = count?.fresh ?? 0;
    }
  }

  private observeSocket(
    socket: SocketRow,
    owner: TrackedProcess | null,
    now: number,
    seen: Set<string>,
  ): void {
    const ident = `${socket.pid}|${socket.protocol}|${socket.localPort}|${socket.remoteAddress}|${socket.remotePort}`;
    seen.add(ident);
    if (this.connections.has(ident)) return;
    const name = this.addressName(socket.remoteAddress, now);
    const program = owner?.program ?? this.launches.get(socket.pid)?.program ?? `pid ${socket.pid}`;
    const root = owner?.section ?? "daemon";
    const host = name ?? socket.remoteAddress;
    const key = baselineKey({ program, host, port: socket.remotePort, protocol: socket.protocol });
    this.connections.set(ident, { pid: socket.pid, key });
    const { entry } = this.baseline.observe({
      program,
      host,
      address: name ? socket.remoteAddress : null,
      port: socket.remotePort,
      protocol: socket.protocol,
      root,
      atMs: now,
    });
    if (this.seenByHooks(socket, now)) return;
    this.options.onRecord(
      this.connectionRecord({ socket, owner, program, root, host, name, known: entry, now }),
    );
  }

  /** The daemon's own sockets are already logged by the in-process hooks. */
  private seenByHooks(socket: SocketRow, now: number): boolean {
    const hooked = this.hookSeen.get(`${socket.remoteAddress}:${socket.remotePort}`);
    return socket.pid === process.pid && hooked !== undefined && now - hooked < HOOK_SEEN_MS;
  }

  private connectionRecord(input: {
    socket: SocketRow;
    owner: TrackedProcess | null;
    program: string;
    root: string;
    host: string;
    name: string | null;
    known: BaselineEntry;
    now: number;
  }): NetworkActivityRequest {
    const { socket, owner, program, root, host, name, now } = input;
    const agentId = owner?.agentId ?? this.launches.get(socket.pid)?.agentId ?? null;
    let fallbackPurpose: string = NETWORK_PURPOSE.socket;
    if (root === "terminals") fallbackPurpose = "Terminals";
    return {
      id: `s-${++this.sequence}`,
      source: root === "app" ? "app" : "daemon",
      startedAtMs: now,
      method: socket.protocol === "tcp" ? "CONNECT" : "UDP",
      protocol: socket.protocol,
      host,
      port: socket.remotePort,
      path: "/",
      status: null,
      errorCode: null,
      durationMs: null,
      responseBytes: null,
      purpose: owner?.purpose ?? fallbackPurpose,
      known: this.baseline.isKnown(input.known),
      local: false,
      state: "complete",
      pid: socket.pid,
      program,
      root,
      ...(agentId ? { agentId } : {}),
      ...(name ? { address: socket.remoteAddress } : {}),
    };
  }

  private pruneNames(now: number): void {
    for (const [address, entry] of this.addressNames) {
      if (now - entry.atMs > NAME_TTL_MS) this.addressNames.delete(address);
    }
    for (const [key, at] of this.hookSeen) if (now - at > HOOK_SEEN_MS) this.hookSeen.delete(key);
  }

  /** Forward-resolves the known hosts so their addresses can be named. Never reverse DNS. */
  private resolveKnownHosts(now: number): void {
    const hosts = [...knownResolveHosts(), ...this.baseline.expectedHostNames()];
    for (const host of hosts) {
      const last = this.resolved.get(host);
      if (last !== undefined && now - last < RESOLVE_INTERVAL_MS) continue;
      this.resolved.set(host, now);
      lookupUnobserved(host, { all: true })
        .then((results) =>
          this.noteResolved(
            host,
            results.map((result) => result.address),
          ),
        )
        .catch(() => undefined);
    }
  }

  // ---- outputs --------------------------------------------------------------------------

  get hasSampled(): boolean {
    return this.sampledAtMs > 0;
  }

  processes(): ResourceProcess[] {
    return this.tracked.map(({ program: _program, ...entry }) => entry);
  }

  destinations(resolveNames: boolean): ResourceDestination[] {
    const livePids = new Map<string, Set<number>>();
    for (const connection of this.connections.values()) {
      const set = livePids.get(connection.key) ?? new Set<number>();
      set.add(connection.pid);
      livePids.set(connection.key, set);
    }
    const agentByPid = new Map(this.tracked.map((entry) => [entry.pid, entry.agentId]));
    const all: ResourceDestination[] = [];
    for (const entry of this.baseline.all()) {
      const pids = livePids.get(entry.key);
      const agentId = pids
        ? ([...pids].map((pid) => agentByPid.get(pid)).find(Boolean) ?? null)
        : null;
      const ipOnly = isIpOnly(entry);
      const hostname = ipOnly && resolveNames ? this.reverseNames.name(entry.host) : null;
      all.push({
        key: entry.key,
        program: entry.program,
        host: entry.host,
        address: entry.address,
        ...(hostname ? { hostname } : {}),
        port: entry.port,
        protocol: entry.protocol,
        firstSeenMs: entry.firstSeenMs,
        lastSeenMs: entry.lastSeenMs,
        count: entry.count,
        trusted: entry.trusted,
        known: this.baseline.isKnown(entry),
        ipOnly: ipOnly && !hostname,
        live: pids !== undefined,
        pids: pids ? [...pids] : [],
        agentId,
        root: entry.root,
      });
    }
    // Unrecognized destinations always ship; the rest are the most recent.
    all.sort((a, b) => b.lastSeenMs - a.lastSeenMs);
    const fresh = all.filter((entry) => !entry.known);
    const rest = all
      .filter((entry) => entry.known)
      .slice(0, Math.max(0, MAX_DESTINATIONS - fresh.length));
    return [...fresh, ...rest];
  }
}
