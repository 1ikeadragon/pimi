import type {
  NetworkActivityHost,
  NetworkActivityRequest,
  NetworkActivitySnapshot,
} from "./messages.js";

// Shared by the daemon and the desktop main process so both produce the same records.
// Records carry method, host, port and path only: query strings, fragments, headers and
// bodies can hold credentials and are never stored. Process launches (git, gh, language
// servers, agent providers) are recorded the same way with protocol "process": the host is
// the program's basename and the path is its redacted arguments. What those programs send
// over the network themselves is not visible to Pimi.

export const NETWORK_PURPOSE = {
  local: "Local",
  localNetwork: "Local network",
  updates: "Updates/GitHub",
  spaces: "Spaces previews",
  usage: "Provider usage",
  relay: "Relay",
  relayData: "Relay data",
  inbound: "Inbound",
  git: "Git",
  githubCli: "GitHub CLI",
  gitHostCli: "Git host CLI",
  languageServer: "Language server",
  mcp: "MCP",
  agentProvider: "Agent provider",
  process: "Programs",
  socket: "Direct connections",
  dns: "DNS lookups",
  plugins: "Plugins",
  speech: "Speech models",
  app: "App",
  browser: "In-app browser",
  other: "Other",
} as const;

// Suffix match on the lowercased host: "github.com" matches "github.com" and "api.github.com".
const HOST_RULES: ReadonlyArray<readonly [suffix: string, purpose: string]> = [
  ["github.com", NETWORK_PURPOSE.updates],
  ["githubusercontent.com", NETWORK_PURPOSE.updates],
  ["registry.npmjs.org", NETWORK_PURPOSE.updates],
  ["arxiv.org", NETWORK_PURPOSE.spaces],
  ["x.com", NETWORK_PURPOSE.spaces],
  ["twitter.com", NETWORK_PURPOSE.spaces],
  ["twimg.com", NETWORK_PURPOSE.spaces],
  ["youtube.com", NETWORK_PURPOSE.spaces],
  ["youtube-nocookie.com", NETWORK_PURPOSE.spaces],
  ["youtu.be", NETWORK_PURPOSE.spaces],
  ["ytimg.com", NETWORK_PURPOSE.spaces],
  ["googlevideo.com", NETWORK_PURPOSE.spaces],
  ["chatgpt.com", NETWORK_PURPOSE.usage],
  ["api.openai.com", NETWORK_PURPOSE.usage],
  ["api.anthropic.com", NETWORK_PURPOSE.usage],
  ["claude.ai", NETWORK_PURPOSE.usage],
  ["openrouter.ai", NETWORK_PURPOSE.usage],
  ["opencode.ai", NETWORK_PURPOSE.usage],
  ["z.ai", NETWORK_PURPOSE.usage],
  ["githubcopilot.com", NETWORK_PURPOSE.usage],
  ["generativelanguage.googleapis.com", NETWORK_PURPOSE.usage],
  ["cloudcode-pa.googleapis.com", NETWORK_PURPOSE.usage],
  ["stateless.computer", NETWORK_PURPOSE.relay],
];

export interface NetworkHostClassification {
  purpose: string;
  known: boolean;
  local: boolean;
}

function isLoopback(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127\.\d+\.\d+\.\d+$/.test(host) ||
    /^::ffff:127\.\d+\.\d+\.\d+$/.test(host)
  );
}

function isPrivateNetwork(host: string): boolean {
  if (host.endsWith(".local")) return true;
  const v4 = host.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  return /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
}

function matchesSuffix(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

export function normalizeNetworkHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

export function classifyNetworkHost(
  rawHost: string,
  extraRules: ReadonlyMap<string, string> = new Map(),
): NetworkHostClassification {
  const host = normalizeNetworkHost(rawHost);
  if (host === "" || isLoopback(host)) {
    return { purpose: NETWORK_PURPOSE.local, known: true, local: true };
  }
  if (isPrivateNetwork(host)) {
    return { purpose: NETWORK_PURPOSE.localNetwork, known: true, local: false };
  }
  for (const [suffix, purpose] of extraRules) {
    if (matchesSuffix(host, suffix)) return { purpose, known: true, local: false };
  }
  for (const [suffix, purpose] of HOST_RULES) {
    if (matchesSuffix(host, suffix)) return { purpose, known: true, local: false };
  }
  return { purpose: NETWORK_PURPOSE.other, known: false, local: false };
}

/** Drops everything from the first `?` or `#`. */
export function stripNetworkPathQuery(path: string): string {
  const end = path.search(/[?#]/);
  const bare = end === -1 ? path : path.slice(0, end);
  return bare === "" ? "/" : bare;
}

export interface NetworkActivityStartInput {
  source: string;
  method: string;
  protocol: string;
  host: string;
  port: number | null;
  /** Raw request path; the recorder strips its query and fragment. */
  path: string;
  /** Call-site attribution. Wins over host classification for purpose and known. */
  purpose?: string | null;
  /**
   * For a launched program: where its own traffic is expected to go, when that can be known
   * from its arguments or environment. Never a claim about what the program actually did.
   */
  destination?: string | null;
}

export interface NetworkActivityFinishInput {
  status?: number | null;
  errorCode?: string | null;
  responseBytes?: number | null;
  /** Named totals kept with the record, such as WebSocket message counts. */
  counters?: Record<string, number>;
}

export interface NetworkActivitySnapshotOptions {
  includeLocal?: boolean;
  limit?: number;
}

// Launches that repeat identically (same program, arguments, purpose, destination, outcome)
// within this window of the first one share one row with a count, so a poller cannot push every
// other record out of the ring buffer. Nothing is dropped: the row keeps the count and the time
// of the latest launch, and every launch is still passed to onFinish.
export const REPEAT_WINDOW_MS = 5_000;
const MAX_REPEAT_KEYS = 256;
/** Counter names on a repeated launch's row. */
export const REPEAT_COUNTER = "repeat";
export const REPEAT_LAST_COUNTER = "lastStartedAtMs";

export interface NetworkActivityRecorderOptions {
  idPrefix: string;
  /** Recent requests kept in memory. */
  capacity?: number;
  /** Distinct (source, host) aggregates kept; the least recently seen is evicted past this. */
  maxHosts?: number;
  now?: () => number;
  /** Called once per record when it leaves "pending", with the record's final state. */
  onFinish?: (record: NetworkActivityRequest) => void;
}

function isFailure(record: NetworkActivityRequest): boolean {
  return record.errorCode !== null || (record.status !== null && record.status >= 400);
}

/**
 * Bounded in-memory record of outbound requests: a ring buffer of the most recent requests
 * plus per-host aggregates since start. Both are capped, so memory stays flat however long
 * the process runs.
 */
export class NetworkActivityRecorder {
  private readonly capacity: number;
  private readonly maxHosts: number;
  private readonly idPrefix: string;
  private readonly now: () => number;
  private readonly onFinish: ((record: NetworkActivityRequest) => void) | undefined;
  private readonly ring: NetworkActivityRequest[] = [];
  private next = 0;
  private sequence = 0;
  private droppedHosts = 0;
  private readonly hosts = new Map<string, NetworkActivityHost>();
  private readonly repeats = new Map<string, NetworkActivityRequest>();
  private readonly extraRules = new Map<string, string>();
  readonly capturedSinceMs: number;

  constructor(options: NetworkActivityRecorderOptions) {
    this.idPrefix = options.idPrefix;
    this.capacity = Math.max(1, options.capacity ?? 1000);
    this.maxHosts = Math.max(1, options.maxHosts ?? 500);
    this.now = options.now ?? Date.now;
    this.onFinish = options.onFinish;
    this.capturedSinceMs = this.now();
  }

  /** Adds a host-suffix purpose that wins over the built-in table, such as a configured relay. */
  registerHost(host: string, purpose: string): void {
    const normalized = normalizeNetworkHost(host);
    if (normalized) this.extraRules.set(normalized, purpose);
  }

  start(input: NetworkActivityStartInput): NetworkActivityRequest {
    const host = normalizeNetworkHost(input.host);
    const classification = classifyNetworkHost(host, this.extraRules);
    const attributed = !classification.local && input.purpose ? input.purpose : null;
    const record: NetworkActivityRequest = {
      id: `${this.idPrefix}-${++this.sequence}`,
      source: input.source,
      startedAtMs: this.now(),
      method: input.method.toUpperCase(),
      protocol: input.protocol,
      host,
      port: input.port,
      path: stripNetworkPathQuery(input.path),
      status: null,
      errorCode: null,
      durationMs: null,
      responseBytes: null,
      ...(input.destination ? { destination: input.destination } : {}),
      purpose: attributed ?? classification.purpose,
      known: attributed !== null || classification.known,
      local: classification.local,
      state: "pending",
    };
    if (this.ring.length < this.capacity) this.ring.push(record);
    else this.ring[this.next] = record;
    this.next = (this.next + 1) % this.capacity;
    this.touchHost(record);
    return record;
  }

  addBytes(record: NetworkActivityRequest, bytes: number): void {
    if (record.state !== "pending") return;
    record.responseBytes = (record.responseBytes ?? 0) + bytes;
  }

  finish(record: NetworkActivityRequest, input: NetworkActivityFinishInput): void {
    if (record.state !== "pending") return;
    if (input.status !== undefined && input.status !== null) record.status = input.status;
    if (input.errorCode) record.errorCode = input.errorCode;
    if (input.responseBytes !== undefined && input.responseBytes !== null) {
      record.responseBytes = input.responseBytes;
    }
    if (input.counters) record.counters = { ...record.counters, ...input.counters };
    record.durationMs = Math.max(0, this.now() - record.startedAtMs);
    record.state = record.errorCode ? "error" : "complete";
    const aggregate = this.hosts.get(hostKey(record));
    if (aggregate) {
      if (isFailure(record)) aggregate.errors += 1;
      aggregate.bytes += record.responseBytes ?? 0;
    }
    const folded = this.foldRepeatedLaunch(record);
    try {
      this.onFinish?.(record);
    } catch {
      // A failing sink must never disturb request observation.
    }
    if (folded) this.removeFromRing(record);
  }

  /** Folds a finished launch into an identical recent one. True when `record` was folded. */
  private foldRepeatedLaunch(record: NetworkActivityRequest): boolean {
    if (record.protocol !== "process" || record.counters) return false;
    const key = JSON.stringify([
      record.source,
      record.host,
      record.path,
      record.purpose,
      record.destination ?? null,
      record.status,
      record.errorCode,
    ]);
    const first = this.repeats.get(key);
    if (
      first &&
      first !== record &&
      this.ring.includes(first) &&
      record.startedAtMs - first.startedAtMs < REPEAT_WINDOW_MS
    ) {
      const count = (first.counters?.[REPEAT_COUNTER] ?? 1) + 1;
      first.counters = {
        ...first.counters,
        [REPEAT_COUNTER]: count,
        [REPEAT_LAST_COUNTER]: record.startedAtMs,
      };
      return true;
    }
    this.repeats.delete(key);
    this.repeats.set(key, record);
    if (this.repeats.size > MAX_REPEAT_KEYS) {
      const oldest = this.repeats.keys().next().value;
      if (oldest !== undefined) this.repeats.delete(oldest);
    }
    return false;
  }

  private removeFromRing(record: NetworkActivityRequest): void {
    const index = this.ring.indexOf(record);
    if (index === -1) return;
    const ordered = [...this.ring.slice(this.next), ...this.ring.slice(0, this.next)].filter(
      (entry) => entry !== record,
    );
    this.ring.splice(0, this.ring.length, ...ordered);
    this.next = ordered.length % this.capacity;
  }

  /**
   * Adds a record another thread or process already finished, such as a plugin process's
   * request. The record is copied with a fresh id and the host classification and aggregates
   * are applied here, so the sender cannot mislabel itself as a known host.
   */
  ingest(
    input: NetworkActivityStartInput & NetworkActivityFinishInput & { durationMs?: number | null },
  ): void {
    const record = this.start(input);
    const duration = input.durationMs;
    this.finish(record, input);
    if (typeof duration === "number" && Number.isFinite(duration) && duration >= 0) {
      record.durationMs = duration;
    }
  }

  /** Removes a pending record that turned out not to be a request, and its host count. */
  discard(record: NetworkActivityRequest): void {
    if (record.state !== "pending") return;
    const index = this.ring.indexOf(record);
    if (index === -1) return;
    // Rebuild oldest-first without the record so the write position stays at the end.
    const ordered = [...this.ring.slice(this.next), ...this.ring.slice(0, this.next)].filter(
      (entry) => entry !== record,
    );
    this.ring.splice(0, this.ring.length, ...ordered);
    this.next = ordered.length % this.capacity;
    const key = hostKey(record);
    const aggregate = this.hosts.get(key);
    if (!aggregate) return;
    aggregate.count -= 1;
    if (aggregate.count <= 0) this.hosts.delete(key);
  }

  snapshot(options: NetworkActivitySnapshotOptions = {}): NetworkActivitySnapshot {
    const limit = Math.min(options.limit ?? this.capacity, this.capacity);
    const requests: NetworkActivityRequest[] = [];
    for (let offset = 1; offset <= this.ring.length && requests.length < limit; offset += 1) {
      const index = (this.next - offset + this.ring.length * 2) % this.ring.length;
      const record = this.ring[index];
      if (!record || (record.local && !options.includeLocal)) continue;
      requests.push({ ...record });
    }
    // Copies, because the recorder keeps mutating its records after the snapshot is taken.
    const hosts: NetworkActivityHost[] = [];
    for (const host of this.hosts.values()) hosts.push({ ...host });
    return {
      capturedSinceMs: this.capturedSinceMs,
      requests,
      hosts,
      droppedHosts: this.droppedHosts,
    };
  }

  private touchHost(record: NetworkActivityRequest): void {
    const key = hostKey(record);
    const existing = this.hosts.get(key);
    if (existing) {
      // Re-insert so Map order stays least-recently-seen first.
      this.hosts.delete(key);
      existing.count += 1;
      existing.lastSeenMs = record.startedAtMs;
      if (record.known && (!existing.known || record.purpose !== NETWORK_PURPOSE.other)) {
        existing.purpose = record.purpose;
        existing.known = true;
      }
      this.hosts.set(key, existing);
      return;
    }
    this.hosts.set(key, {
      source: record.source,
      host: record.host,
      purpose: record.purpose,
      known: record.known,
      local: record.local,
      count: 1,
      errors: 0,
      bytes: 0,
      lastSeenMs: record.startedAtMs,
    });
    if (this.hosts.size > this.maxHosts) {
      const oldest = this.hosts.keys().next().value;
      if (oldest !== undefined) {
        this.hosts.delete(oldest);
        this.droppedHosts += 1;
      }
    }
  }
}

function hostKey(record: { source: string; host: string }): string {
  return `${record.source}\u0000${record.host}`;
}
