import type {
  NetworkActivityHost,
  NetworkActivityRequest,
  NetworkActivitySnapshot,
} from "@pimi/protocol/messages";

export type NetworkSource = "daemon" | "app" | "browser";

export interface NetworkFilter {
  query: string;
  sources: Record<NetworkSource, boolean>;
  showLocal: boolean;
}

export interface NetworkTotals {
  requests: number;
  hosts: number;
  errors: number;
  unknownHosts: number;
  /** Requests to loopback hosts left out of the counts above because Show local is off. */
  hiddenLocalRequests: number;
}

export interface NetworkHostGroup {
  purpose: string;
  known: boolean;
  count: number;
  hosts: NetworkActivityHost[];
}

export interface NetworkView {
  totals: NetworkTotals;
  groups: NetworkHostGroup[];
  requests: NetworkActivityRequest[];
}

export const NETWORK_SOURCE_LABELS: Record<NetworkSource, string> = {
  daemon: "Daemon",
  app: "App",
  browser: "In-app browser",
};

export function networkSourceLabel(source: string): string {
  return source in NETWORK_SOURCE_LABELS ? NETWORK_SOURCE_LABELS[source as NetworkSource] : source;
}

function sourceVisible(source: string, filter: NetworkFilter): boolean {
  return source in filter.sources ? filter.sources[source as NetworkSource] : true;
}

function matchesQuery(fields: readonly string[], query: string): boolean {
  if (!query) return true;
  return fields.some((field) => field.toLowerCase().includes(query));
}

function compareHosts(a: NetworkActivityHost, b: NetworkActivityHost): number {
  if (a.known !== b.known) return a.known ? 1 : -1;
  return b.lastSeenMs - a.lastSeenMs || b.count - a.count;
}

/**
 * Merges the daemon's and the desktop app's snapshots into one glanceable view: unknown hosts
 * first, hosts grouped by purpose, and the newest requests first.
 */
export function buildNetworkView(input: {
  snapshots: readonly (NetworkActivitySnapshot | null | undefined)[];
  filter: NetworkFilter;
}): NetworkView {
  const query = input.filter.query.trim().toLowerCase();
  const allHosts = input.snapshots.flatMap((snapshot) => snapshot?.hosts ?? []);
  const visibleSourceHosts = allHosts.filter((host) => sourceVisible(host.source, input.filter));
  const hosts = visibleSourceHosts.filter(
    (host) =>
      (input.filter.showLocal || !host.local) &&
      matchesQuery([host.host, host.purpose, host.source], query),
  );

  const totals: NetworkTotals = {
    requests: 0,
    hosts: hosts.length,
    errors: 0,
    unknownHosts: 0,
    hiddenLocalRequests: input.filter.showLocal
      ? 0
      : visibleSourceHosts.reduce((sum, host) => sum + (host.local ? host.count : 0), 0),
  };
  for (const host of hosts) {
    totals.requests += host.count;
    totals.errors += host.errors;
    if (!host.known) totals.unknownHosts += 1;
  }

  const byPurpose = new Map<string, NetworkHostGroup>();
  for (const host of hosts) {
    const key = host.known ? host.purpose : "Other";
    let group = byPurpose.get(key);
    if (!group) {
      group = { purpose: key, known: host.known, count: 0, hosts: [] };
      byPurpose.set(key, group);
    }
    group.count += host.count;
    group.hosts.push(host);
  }
  for (const group of byPurpose.values()) group.hosts.sort(compareHosts);
  const groups = [...byPurpose.values()].sort((a, b) => {
    if (a.known !== b.known) return a.known ? 1 : -1;
    return b.count - a.count;
  });

  const requests = input.snapshots
    .flatMap((snapshot) => snapshot?.requests ?? [])
    .filter(
      (request) =>
        sourceVisible(request.source, input.filter) &&
        (input.filter.showLocal || !request.local) &&
        matchesQuery(
          [request.host, request.path, request.method, request.purpose, request.errorCode ?? ""],
          query,
        ),
    )
    .sort((a, b) => b.startedAtMs - a.startedAtMs);

  return { totals, groups, requests };
}

export type RequestTone = "success" | "warning" | "error" | "muted";

export function requestStatus(request: NetworkActivityRequest): {
  label: string;
  tone: RequestTone;
} {
  if (request.errorCode) return { label: request.errorCode, tone: "error" };
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
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(ms: number | null): string | null {
  if (ms === null) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function formatRequestTarget(request: NetworkActivityRequest): string {
  const port = request.port ? `:${request.port}` : "";
  const host = request.protocol === "unix" ? "unix socket" : `${request.host}${port}`;
  return `${host}${request.path}`;
}
