import type {
  NetworkActivityRequest,
  NetworkActivitySnapshot,
  ResourceDestination,
  ResourceProcess,
} from "@pimi/protocol/messages";
import { REPEAT_COUNTER, REPEAT_LAST_COUNTER } from "@pimi/protocol/network-activity";
import { formatTimeOfDay } from "@/utils/time";

export type NetworkSource = "daemon" | "app" | "browser";

export const NETWORK_SOURCE_LABELS: Record<NetworkSource, string> = {
  daemon: "Daemon",
  app: "App",
  browser: "In-app browser",
};

export function networkSourceLabel(source: string): string {
  return source in NETWORK_SOURCE_LABELS ? NETWORK_SOURCE_LABELS[source as NetworkSource] : source;
}

// ---- process tree ----------------------------------------------------------------------

export interface ProcessNode {
  id: string;
  label: string;
  /** The OS pid, for a real process; null for a group (App, Daemon, an agent). */
  pid: number | null;
  cpuPercent: number | null;
  rssBytes: number;
  connections: number;
  newDestinations: number;
  children: ProcessNode[];
}

export interface ProcessTreeInput {
  processes: readonly ResourceProcess[];
  /** Electron's names for the app's processes, by pid. */
  appLabels: ReadonlyMap<number, string>;
  agentTitle: (agentId: string) => string | null;
  labels: { app: string; daemon: string; terminals: string; supervisor: string; worker: string };
}

function leaf(entry: ResourceProcess, label: string): ProcessNode {
  return {
    id: `p${entry.pid}`,
    label,
    pid: entry.pid,
    cpuPercent: entry.cpuPercent,
    rssBytes: entry.rssBytes,
    connections: entry.connections,
    newDestinations: entry.newDestinations,
    children: [],
  };
}

function sumCpu(values: readonly (number | null)[]): number | null {
  let total: number | null = null;
  for (const value of values) if (value !== null) total = (total ?? 0) + value;
  return total;
}

/** A node whose numbers are its own plus everything below it. */
function rollUp(node: ProcessNode): ProcessNode {
  const children = node.children.map(rollUp).sort(byCpuThenMemory);
  return {
    ...node,
    children,
    cpuPercent: sumCpu([node.cpuPercent, ...children.map((child) => child.cpuPercent)]),
    rssBytes: node.rssBytes + children.reduce((sum, child) => sum + child.rssBytes, 0),
    connections: node.connections + children.reduce((sum, child) => sum + child.connections, 0),
    newDestinations:
      node.newDestinations + children.reduce((sum, child) => sum + child.newDestinations, 0),
  };
}

function group(id: string, label: string, children: ProcessNode[]): ProcessNode {
  return {
    id,
    label,
    pid: null,
    cpuPercent: null,
    rssBytes: 0,
    connections: 0,
    newDestinations: 0,
    children,
  };
}

function byCpuThenMemory(a: ProcessNode, b: ProcessNode): number {
  return (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0) || b.rssBytes - a.rssBytes;
}

/** Builds the parent-child forest of a section from the flat list, inside that section only. */
function forest(
  entries: readonly ResourceProcess[],
  labelOf: (entry: ResourceProcess) => string,
): { nodes: Map<number, ProcessNode>; roots: ProcessNode[] } {
  const nodes = new Map<number, ProcessNode>();
  for (const entry of entries) nodes.set(entry.pid, leaf(entry, labelOf(entry)));
  const roots: ProcessNode[] = [];
  for (const entry of entries) {
    const node = nodes.get(entry.pid)!;
    const parent = nodes.get(entry.ppid);
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  return { nodes, roots };
}

export function buildProcessTree(input: ProcessTreeInput): ProcessNode[] {
  const result: ProcessNode[] = [];
  const bySection = (section: ResourceProcess["section"]) =>
    input.processes.filter((entry) => entry.section === section);

  const appEntries = bySection("app");
  if (appEntries.length > 0) {
    // Electron's helpers all hang off the main process; show them as one flat level.
    const nodes = appEntries.map((entry) =>
      leaf(entry, input.appLabels.get(entry.pid) ?? entry.name),
    );
    result.push(rollUp(group("app", input.labels.app, nodes.sort(byCpuThenMemory))));
  }

  const daemonEntries = bySection("daemon");
  const daemon = daemonEntries.find((entry) => entry.role === "daemon");
  if (daemon) {
    const { nodes, roots } = forest(daemonEntries, (entry) => entry.name);
    const daemonNode = nodes.get(daemon.pid)!;
    const supervisor = daemonEntries.find((entry) => entry.role === "supervisor");
    // The supervisor is the daemon's parent in the OS tree; show it beside the daemon.
    const supervisorNode = supervisor ? nodes.get(supervisor.pid) : undefined;
    if (supervisorNode) {
      supervisorNode.children = supervisorNode.children.filter((child) => child !== daemonNode);
      supervisorNode.label = input.labels.supervisor;
    }
    daemonNode.label = input.labels.daemon;
    // Agents: every launch of an agent, and what it started, sits under one row for the agent.
    const agents = new Map<string, ProcessNode[]>();
    const rest: ProcessNode[] = [];
    for (const child of daemonNode.children) {
      const entry = daemonEntries.find((candidate) => candidate.pid === child.pid);
      if (entry?.agentId) {
        const list = agents.get(entry.agentId) ?? [];
        list.push(child);
        agents.set(entry.agentId, list);
      } else {
        rest.push(child);
      }
    }
    const agentNodes = [...agents].map(([agentId, children]) =>
      group(`agent-${agentId}`, input.agentTitle(agentId) ?? agentId.slice(0, 8), children),
    );
    const others = roots.filter((root) => root !== daemonNode && root !== supervisorNode);
    daemonNode.children = [
      ...agentNodes,
      ...rest,
      ...others,
      ...(supervisorNode ? [supervisorNode] : []),
    ];
    daemonNode.id = "daemon";
    result.push(rollUp(daemonNode));
  }

  const terminalEntries = bySection("terminals");
  if (terminalEntries.length > 0) {
    const { roots } = forest(terminalEntries, (entry) => entry.name);
    const workers = roots.filter((node) => {
      const entry = terminalEntries.find((candidate) => candidate.pid === node.pid);
      return entry?.role === "terminal-worker";
    });
    // Programs hang off the worker; lift them so "Terminals" lists programs directly.
    const programs = workers.flatMap((worker) => worker.children);
    for (const worker of workers) {
      worker.children = [];
      worker.label = input.labels.worker;
    }
    const others = roots.filter((node) => !workers.includes(node));
    const topNode = group("terminals", input.labels.terminals, [
      ...programs,
      ...others,
      ...workers,
    ]);
    result.push(rollUp(topNode));
  }
  return result;
}

// ---- destinations ----------------------------------------------------------------------

export interface DestinationView {
  fresh: ResourceDestination[];
  known: ResourceDestination[];
  byProcess: Array<{ program: string; destinations: ResourceDestination[] }>;
}

export function buildDestinationView(
  destinations: readonly ResourceDestination[],
): DestinationView {
  const fresh = destinations
    .filter((entry) => !entry.known)
    .sort((a, b) => b.lastSeenMs - a.lastSeenMs);
  const known = destinations
    .filter((entry) => entry.known)
    .sort((a, b) => b.lastSeenMs - a.lastSeenMs);
  const groups = new Map<string, ResourceDestination[]>();
  for (const entry of destinations) {
    const list = groups.get(entry.program) ?? [];
    list.push(entry);
    groups.set(entry.program, list);
  }
  const byProcess = [...groups]
    .map(([program, list]) => ({
      program,
      destinations: list.sort((a, b) => b.lastSeenMs - a.lastSeenMs),
    }))
    .sort((a, b) => b.destinations[0]!.lastSeenMs - a.destinations[0]!.lastSeenMs);
  return { fresh, known, byProcess };
}

export function destinationTarget(
  entry: Pick<ResourceDestination, "host" | "port" | "hostname">,
): string {
  const ip = entry.host.includes(":") ? `[${entry.host}]` : entry.host;
  return entry.hostname ? `${entry.hostname}:${entry.port} (${ip})` : `${ip}:${entry.port}`;
}

// ---- recent requests -------------------------------------------------------------------

export function mergeRequests(
  snapshots: readonly (NetworkActivitySnapshot | null | undefined)[],
): NetworkActivityRequest[] {
  return snapshots
    .flatMap((snapshot) => snapshot?.requests ?? [])
    .sort((a, b) => b.startedAtMs - a.startedAtMs);
}

export type RequestTone = "success" | "warning" | "error" | "muted";

export function requestStatus(request: NetworkActivityRequest): {
  label: string;
  tone: RequestTone;
} {
  if (request.errorCode) return { label: request.errorCode, tone: "error" };
  if (request.protocol === "process") {
    // The status of a launched program is its exit code. Zero is success; anything else is
    // the program's own report, not necessarily a failure of Pimi.
    if (request.status === null) {
      return { label: request.state === "pending" ? "Running" : "No exit code", tone: "muted" };
    }
    return request.status === 0
      ? { label: "Exit 0", tone: "success" }
      : { label: `Exit ${request.status}`, tone: "warning" };
  }
  if (request.status === null) {
    return { label: request.state === "pending" ? "Pending" : "No status", tone: "muted" };
  }
  if (request.status >= 500) return { label: String(request.status), tone: "error" };
  if (request.status >= 400) return { label: String(request.status), tone: "warning" };
  return { label: String(request.status), tone: "success" };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatCpu(percent: number | null): string {
  if (percent === null) return "–";
  return `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
}

export function formatDuration(ms: number | null): string | null {
  if (ms === null) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function formatRequestTarget(request: NetworkActivityRequest): string {
  if (request.protocol === "process") {
    const command = request.path === "/" ? request.host : `${request.host} ${request.path}`;
    return request.destination ? `${command} → ${request.destination}` : command;
  }
  if (request.protocol === "tcp" || request.protocol === "udp" || request.protocol === "dns") {
    const port = request.port ? `:${request.port}` : "";
    return `${request.protocol} ${request.host}${port}`;
  }
  const port = request.port ? `:${request.port}` : "";
  const host = request.protocol === "unix" ? "unix socket" : `${request.host}${port}`;
  return `${host}${request.path}`;
}

/** "12 times, last 01:19:44" for a launch the daemon folded repeats into, otherwise null. */
export function repeatLabel(request: NetworkActivityRequest): string | null {
  const count = request.counters?.[REPEAT_COUNTER];
  if (!count || count < 2) return null;
  const last = request.counters?.[REPEAT_LAST_COUNTER] ?? request.startedAtMs;
  return `${count} times, last ${formatTimeOfDay(new Date(last))}`;
}
