import { AsyncLocalStorage } from "node:async_hooks";
import diagnosticsChannel from "node:diagnostics_channel";
import dgram from "node:dgram";
import dns from "node:dns";
import type { ClientRequest, IncomingMessage } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import type { Socket } from "node:net";
import { parentPort, type Worker } from "node:worker_threads";
import {
  NETWORK_PURPOSE,
  NetworkActivityRecorder,
  type NetworkActivitySnapshotOptions,
  type NetworkActivityStartInput,
} from "@pimi/protocol/network-activity";
import type { NetworkActivityRequest, NetworkActivitySnapshot } from "@pimi/protocol/messages";
import { setProcessLaunchObserver } from "../../utils/process-launch.js";
import { maskPathSegments } from "./redact.js";
import { NetworkLogStore, type NetworkLogSettings, type NetworkLogStats } from "./log-store.js";
import { createProcessLaunchObserver, type SpawnedProgram } from "./process-launch-recorder.js";
import { ResourceMonitor } from "../resources/resource-monitor.js";

// Outbound observation through Node's built-in diagnostics channels plus two wrapped modules.
// Channels see global fetch (undici, including the proxy dispatcher), node:http/https (which
// also carries ws WebSocket handshakes), and every TCP client socket (net.client.socket). The
// socket hook records only connections no HTTP request explains, such as raw TLS or a database
// driver. DNS has no channel, so the explicit resolver calls of node:dns are wrapped. Neither
// sees inside child processes (agent providers, git, gh, language servers, terminals): their
// launches are recorded through the process launch observer, their own traffic is not visible.
// Plugin processes report their records to the daemon over IPC, see ingestChildNetworkBatch.

const initiator = new AsyncLocalStorage<string>();

// The Resources tab's sampler. Until it starts, launches wait here.
let resourceMonitor: ResourceMonitor | null = null;
const pendingSpawns: SpawnedProgram[] = [];
const MAX_PENDING_SPAWNS = 200;

function noteResolved(name: string | null | undefined, addresses: readonly string[]): void {
  if (!name || addresses.length === 0) return;
  resourceMonitor?.noteResolved(name, addresses);
}

function addressesOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(addressesOf);
  if (value && typeof value === "object") {
    const address = (value as { address?: unknown }).address;
    if (typeof address === "string") return [address];
  }
  return [];
}

/**
 * Attributes every outbound request started inside `run` (including awaited continuations)
 * to `purpose`. A request with no attribution falls back to host classification.
 */
export function withNetworkInitiator<T>(purpose: string, run: () => T): T {
  return initiator.run(purpose, run);
}

interface UndiciRequest {
  origin?: string | URL;
  method?: string;
  path?: string;
}

interface UndiciRequestMessage {
  request: UndiciRequest;
}

interface UndiciHeadersMessage extends UndiciRequestMessage {
  response: { statusCode: number };
}

interface UndiciChunkMessage extends UndiciRequestMessage {
  chunk: { length: number };
}

interface UndiciErrorMessage extends UndiciRequestMessage {
  error: unknown;
}

interface HttpRequestMessage {
  request: ClientRequest;
}

interface HttpErrorMessage extends HttpRequestMessage {
  error: unknown;
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object") {
    const record = error as { code?: unknown; name?: unknown; cause?: unknown };
    if (typeof record.code === "string" && record.code) return record.code;
    if (record.cause) return errorCode(record.cause);
    if (typeof record.name === "string" && record.name) return record.name;
  }
  return "ERROR";
}

function undiciStart(request: UndiciRequest, source: string): NetworkActivityStartInput | null {
  if (!request.origin) return null;
  const origin = URL.parse(String(request.origin));
  if (!origin) return null;
  return {
    source,
    method: request.method ?? "GET",
    protocol: origin.protocol.replace(/:$/, ""),
    host: origin.hostname,
    port: origin.port ? Number(origin.port) : null,
    path: maskPathSegments(request.path ?? "/"),
    purpose: initiator.getStore() ?? null,
  };
}

function httpStart(request: ClientRequest, source: string): NetworkActivityStartInput {
  const secure = request.protocol === "https:";
  const upgrade = request.getHeader("upgrade");
  const isWebSocket = typeof upgrade === "string" && upgrade.toLowerCase() === "websocket";
  const socketPath = (request as ClientRequest & { socketPath?: string }).socketPath;
  // Prefer the Host header: callers that dial a vetted IP directly (link previews) keep the
  // site's name there, and the name is what the owner needs to recognize.
  const hostHeader = request.getHeader("host");
  const named = typeof hostHeader === "string" ? URL.parse(`http://${hostHeader}`) : null;
  const port = named?.port;
  let scheme = secure ? "https" : "http";
  if (isWebSocket) scheme = secure ? "wss" : "ws";
  return {
    source,
    method: request.method,
    protocol: socketPath ? "unix" : scheme,
    host: socketPath ? "" : (named?.hostname ?? request.host),
    port: port ? Number(port) : null,
    path: maskPathSegments(request.path),
    purpose: initiator.getStore() ?? null,
  };
}

function contentLength(response: IncomingMessage | null | undefined): number | null {
  const header = response?.headers["content-length"];
  if (typeof header !== "string" || !/^\d+$/.test(header)) return null;
  return Number(header);
}

// Destinations an HTTP request was just made to. A TCP connection to one of them is that
// request's transport, not a separate event.
const RECENT_HTTP_MS = 30_000;
const MAX_RECENT_HTTP = 256;

function defaultPort(protocol: string): number {
  return protocol === "https" || protocol === "wss" ? 443 : 80;
}

class RecentHttpDestinations {
  private readonly seen = new Map<string, number>();

  note(input: NetworkActivityStartInput): void {
    const key = `${input.host.toLowerCase()}:${input.port ?? defaultPort(input.protocol)}`;
    this.seen.delete(key);
    this.seen.set(key, Date.now());
    if (this.seen.size > MAX_RECENT_HTTP) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }

  has(host: string | undefined, port: number | undefined): boolean {
    if (!host || port === undefined) return false;
    const at = this.seen.get(`${host.toLowerCase().replace(/^\[|\]$/g, "")}:${port}`);
    return at !== undefined && Date.now() - at < RECENT_HTTP_MS;
  }
}

interface DialedSocket extends Socket {
  /** Set by net.connect to the name that was dialed, before and after DNS. */
  _host?: string | null;
}

/**
 * Records TCP client sockets that no HTTP request explains. The record is written when the
 * socket connects, or when it fails before connecting.
 */
function observeSocket(
  socket: DialedSocket,
  recorder: NetworkActivityRecorder,
  source: string,
  recentHttp: RecentHttpDestinations,
): void {
  const purpose = initiator.getStore() ?? NETWORK_PURPOSE.socket;
  const emit = (failure: string | null): void => {
    const host = socket._host ?? socket.remoteAddress;
    // Pipes and IPC have no host: they never leave the machine.
    if (!host) return;
    const port = socket.remotePort;
    if (failure === null && socket.remoteAddress && port !== undefined) {
      noteResolved(socket._host, [socket.remoteAddress]);
      resourceMonitor?.noteHookConnection(socket.remoteAddress, port);
    }
    if (
      recentHttp.has(socket._host ?? undefined, port) ||
      recentHttp.has(socket.remoteAddress, port)
    ) {
      return;
    }
    const record = recorder.start({
      source,
      method: "CONNECT",
      protocol: "tcp",
      host,
      port: port ?? null,
      path: "/",
      purpose,
    });
    recorder.finish(record, { errorCode: failure });
  };
  let connected = false;
  socket.once("connect", () => {
    connected = true;
    emit(null);
  });
  socket.once("error", (error: NodeJS.ErrnoException) => {
    if (!connected) emit(typeof error.code === "string" ? error.code : "ERROR");
  });
}

const DNS_RESOLVE_CALLBACK_FUNCTIONS = [
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCaa",
  "resolveCname",
  "resolveMx",
  "resolveNaptr",
  "resolveNs",
  "resolvePtr",
  "resolveSoa",
  "resolveSrv",
  "resolveTxt",
  "reverse",
] as const;

type DnsFunction = (...args: unknown[]) => unknown;

// net.connect resolves names through dns.lookup, and that connection is observed as a socket.
// A lookup made from inside node:net is therefore skipped; every other caller is recorded.
function calledFromNet(skip: Function): boolean {
  const holder: { stack?: string } = {};
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 4;
  Error.captureStackTrace(holder, skip);
  Error.stackTraceLimit = limit;
  return holder.stack?.includes("node:net") ?? false;
}

/**
 * Wraps the explicit name-resolution calls of node:dns (callback and promise forms), which
 * have no diagnostics channel. Returns the function that restores the originals.
 */
function installDnsMonitor(recorder: NetworkActivityRecorder, source: string): () => void {
  const restores: Array<() => void> = [];

  const start = (method: string, name: unknown) =>
    recorder.start({
      source,
      method,
      protocol: "dns",
      host: typeof name === "string" ? name : "",
      port: null,
      path: "/",
      purpose: initiator.getStore() ?? NETWORK_PURPOSE.dns,
    });

  const wrap = (target: Record<string, unknown>, name: string, promise: boolean): void => {
    const original = target[name] as DnsFunction | undefined;
    if (typeof original !== "function") return;
    let method = "RESOLVE";
    if (name === "lookup") method = "LOOKUP";
    else if (name === "reverse") method = "REVERSE";
    const wrapper = function (this: unknown, ...args: unknown[]): unknown {
      if (!promise && name === "lookup" && calledFromNet(wrapper)) {
        return original.apply(this, args);
      }
      const record = start(method, args[0]);
      if (promise) {
        const result = original.apply(this, args) as Promise<unknown>;
        return result.then(
          (value) => {
            if (typeof args[0] === "string") noteResolved(args[0], addressesOf(value));
            recorder.finish(record, {});
            return value;
          },
          (error: unknown) => {
            recorder.finish(record, { errorCode: errorCode(error) });
            throw error;
          },
        );
      }
      const last = args.length - 1;
      const callback = args[last];
      if (typeof callback === "function") {
        args[last] = (error: unknown, ...rest: unknown[]) => {
          if (!error && typeof args[0] === "string") noteResolved(args[0], addressesOf(rest[0]));
          recorder.finish(record, error ? { errorCode: errorCode(error) } : {});
          return (callback as DnsFunction)(error, ...rest);
        };
      }
      try {
        return original.apply(this, args);
      } catch (error) {
        recorder.finish(record, { errorCode: errorCode(error) });
        throw error;
      }
    };
    for (const key of Reflect.ownKeys(original)) {
      if (key === "length" || key === "name" || key === "prototype") continue;
      const descriptor = Object.getOwnPropertyDescriptor(original, key);
      if (descriptor) Object.defineProperty(wrapper, key, descriptor);
    }
    target[name] = wrapper;
    restores.push(() => {
      target[name] = original;
    });
  };

  const callbackApi = dns as unknown as Record<string, unknown>;
  const promiseApi = dns.promises as unknown as Record<string, unknown>;
  wrap(callbackApi, "lookup", false);
  wrap(promiseApi, "lookup", true);
  for (const name of DNS_RESOLVE_CALLBACK_FUNCTIONS) {
    wrap(callbackApi, name, false);
    wrap(promiseApi, name, true);
  }
  // Resolver instances (custom servers, per-request resolvers) bypass the module-level
  // functions above, so wrap their prototype methods as well.
  const callbackResolver = dns.Resolver.prototype as unknown as Record<string, unknown>;
  const promiseResolver = dns.promises.Resolver.prototype as unknown as Record<string, unknown>;
  for (const name of DNS_RESOLVE_CALLBACK_FUNCTIONS) {
    wrap(callbackResolver, name, false);
    wrap(promiseResolver, name, true);
  }
  syncBuiltinESMExports();
  return () => {
    for (const restore of restores) restore();
    syncBuiltinESMExports();
  };
}

// UDP has no diagnostics channel. A datagram socket's send and connect are wrapped, and a
// destination is recorded once per window so a stream of packets is one row, not thousands.
const UDP_REPEAT_WINDOW_MS = 30_000;
const MAX_UDP_DESTINATIONS = 256;

function udpDestination(
  socket: dgram.Socket,
  method: "send" | "connect",
  args: unknown[],
): { host: string; port: number } | null {
  const rest = args.slice(method === "send" ? 1 : 0);
  // send(msg, offset, length, port, address) | send(msg, port, address) | connect(port, address)
  const portAt =
    method === "send" && typeof rest[1] === "number" && typeof rest[2] === "number" ? 2 : 0;
  const port = rest[portAt];
  const address = rest[portAt + 1];
  if (typeof port === "number") {
    return { host: typeof address === "string" ? address : "127.0.0.1", port };
  }
  try {
    const peer = socket.remoteAddress();
    return { host: peer.address, port: peer.port };
  } catch {
    return null;
  }
}

/** True the first time a destination is seen in a window; remembers at most a few hundred. */
function firstInWindow(seen: Map<string, number>, key: string): boolean {
  const now = Date.now();
  const last = seen.get(key);
  if (last !== undefined && now - last <= UDP_REPEAT_WINDOW_MS) return false;
  seen.delete(key);
  seen.set(key, now);
  const oldest = seen.size > MAX_UDP_DESTINATIONS ? seen.keys().next().value : undefined;
  if (oldest !== undefined) seen.delete(oldest);
  return true;
}

function installDgramMonitor(recorder: NetworkActivityRecorder, source: string): () => void {
  const prototype = dgram.Socket.prototype as unknown as Record<string, DnsFunction>;
  const seen = new Map<string, number>();
  const restores: Array<() => void> = [];
  const note = (socket: dgram.Socket, method: "send" | "connect", args: unknown[]): void => {
    const destination = udpDestination(socket, method, args);
    if (!destination || !firstInWindow(seen, `${destination.host}:${destination.port}`)) return;
    const record = recorder.start({
      source,
      method: "SEND",
      protocol: "udp",
      host: destination.host,
      port: destination.port,
      path: "/",
      purpose: initiator.getStore() ?? NETWORK_PURPOSE.socket,
    });
    recorder.finish(record, {});
  };
  for (const method of ["send", "connect"] as const) {
    const original = prototype[method];
    if (typeof original !== "function") continue;
    prototype[method] = function (this: dgram.Socket, ...args: unknown[]): unknown {
      try {
        note(this, method, args);
      } catch {
        // Observation must never affect the datagram.
      }
      return original.apply(this, args);
    };
    restores.push(() => {
      prototype[method] = original;
    });
  }
  return () => {
    for (const restore of restores) restore();
  };
}

/**
 * Subscribes `recorder` to outbound HTTP(S) activity in this process. Returns the unsubscribe
 * function. Records are keyed by request object in WeakMaps, so an abandoned request never
 * pins memory beyond its ring-buffer slot.
 */
export function installNodeNetworkMonitor(input: {
  recorder: NetworkActivityRecorder;
  source: string;
}): () => void {
  const { recorder, source } = input;
  const undiciRecords = new WeakMap<object, NetworkActivityRequest>();
  const httpRecords = new WeakMap<object, NetworkActivityRequest>();
  const recentHttp = new RecentHttpDestinations();

  const handlers: Array<[string, (message: unknown) => void]> = [
    [
      "undici:request:create",
      (message) => {
        const { request } = message as UndiciRequestMessage;
        const start = undiciStart(request, source);
        if (!start) return;
        recentHttp.note(start);
        undiciRecords.set(request, recorder.start(start));
      },
    ],
    [
      "undici:request:headers",
      (message) => {
        const { request, response } = message as UndiciHeadersMessage;
        const record = undiciRecords.get(request);
        if (record) record.status = response.statusCode;
      },
    ],
    [
      "undici:request:bodyChunkReceived",
      (message) => {
        const { request, chunk } = message as UndiciChunkMessage;
        const record = undiciRecords.get(request);
        if (record) recorder.addBytes(record, chunk.length);
      },
    ],
    [
      "undici:request:trailers",
      (message) => {
        const { request } = message as UndiciRequestMessage;
        const record = undiciRecords.get(request);
        if (record) recorder.finish(record, {});
      },
    ],
    [
      "undici:request:error",
      (message) => {
        const { request, error } = message as UndiciErrorMessage;
        const record = undiciRecords.get(request);
        if (record) recorder.finish(record, { errorCode: errorCode(error) });
      },
    ],
    [
      "http.client.request.start",
      (message) => {
        const { request } = message as HttpRequestMessage;
        const start = httpStart(request, source);
        recentHttp.note(start);
        const record = recorder.start(start);
        httpRecords.set(request, record);
        // A 'close' listener does not change request semantics. It fires after a response,
        // after a WebSocket upgrade (request.res is the 101 response), and after an abort.
        request.once("close", () => {
          // Undocumented but stable since Node 0.x: the response this request received.
          const response = (request as ClientRequest & { res?: IncomingMessage | null }).res;
          recorder.finish(record, {
            status: response?.statusCode ?? null,
            responseBytes: contentLength(response),
            errorCode: response ? null : "ABORTED",
          });
        });
      },
    ],
    [
      "http.client.request.error",
      (message) => {
        const { request, error } = message as HttpErrorMessage;
        const record = httpRecords.get(request);
        if (record) recorder.finish(record, { errorCode: errorCode(error) });
      },
    ],
  ];

  handlers.push([
    "net.client.socket",
    (message) => {
      observeSocket((message as { socket: DialedSocket }).socket, recorder, source, recentHttp);
    },
  ]);

  for (const [name, handler] of handlers) diagnosticsChannel.subscribe(name, handler);
  const restoreDns = installDnsMonitor(recorder, source);
  const restoreDgram = installDgramMonitor(recorder, source);
  return () => {
    for (const [name, handler] of handlers) diagnosticsChannel.unsubscribe(name, handler);
    restoreDns();
    restoreDgram();
  };
}

let daemonRecorder: NetworkActivityRecorder | null = null;
let processRecorder: NetworkActivityRecorder | null = null;
let daemonLog: NetworkLogStore | null = null;
// Records that finish before the log store exists (startup requests and launches) wait here.
const MAX_UNSAVED_RECORDS = 2000;
const unsavedRecords: NetworkActivityRequest[] = [];

function saveRecord(record: NetworkActivityRequest): void {
  if (daemonLog) {
    daemonLog.append(record);
    return;
  }
  if (unsavedRecords.length < MAX_UNSAVED_RECORDS) unsavedRecords.push({ ...record });
}

/**
 * The daemon's process-wide recorder for network requests, created on first use. Records go
 * to disk once `startDaemonNetworkLog` has run. Launched programs have a recorder of their
 * own: a startup scan can launch hundreds of git processes, and sharing one buffer would push
 * every real request out of it.
 */
export function getDaemonNetworkActivity(): NetworkActivityRecorder {
  if (!daemonRecorder) {
    daemonRecorder = new NetworkActivityRecorder({
      idPrefix: "d",
      capacity: 1000,
      onFinish: saveRecord,
      isTrustedHost: (host) => resourceMonitor?.baseline.hasTrustedHost(host) ?? false,
    });
    installNodeNetworkMonitor({ recorder: daemonRecorder, source: "daemon" });
    processRecorder = new NetworkActivityRecorder({
      idPrefix: "p",
      capacity: 1000,
      onFinish: saveRecord,
    });
    setProcessLaunchObserver(
      createProcessLaunchObserver(processRecorder, "daemon", (spawned) => {
        if (resourceMonitor) noteSpawn(resourceMonitor, spawned);
        else if (pendingSpawns.length < MAX_PENDING_SPAWNS) pendingSpawns.push(spawned);
      }),
    );
  }
  return daemonRecorder;
}

/** Requests and launched programs together, newest first, as the Resources tab shows them. */
export function snapshotDaemonNetworkActivity(
  options: NetworkActivitySnapshotOptions,
): NetworkActivitySnapshot {
  const requests = getDaemonNetworkActivity().snapshot(options);
  const launches = processRecorder?.snapshot(options);
  if (!launches) return requests;
  const limit = options.limit ?? requests.requests.length + launches.requests.length;
  return {
    capturedSinceMs: Math.min(requests.capturedSinceMs, launches.capturedSinceMs),
    requests: [...requests.requests, ...launches.requests]
      .sort((a, b) => b.startedAtMs - a.startedAtMs)
      .slice(0, limit),
    hosts: [...requests.hosts, ...launches.hosts],
    droppedHosts: requests.droppedHosts + launches.droppedHosts,
  };
}

/** Starts persisting the daemon's network records under `<home>/logs/network`. */
export function startDaemonNetworkLog(input: {
  home: string;
  getSettings: () => NetworkLogSettings;
  onError: (error: unknown, message: string) => void;
}): NetworkLogStore {
  const store = new NetworkLogStore({ ...input, source: "daemon" });
  daemonLog = store;
  getDaemonNetworkActivity();
  store.start();
  for (const record of unsavedRecords.splice(0)) store.append(record);
  return store;
}

function noteSpawn(monitor: ResourceMonitor, spawned: SpawnedProgram): void {
  monitor.noteLaunch(spawned.pid, spawned);
  if (spawned.expectedHost) monitor.baseline.expectHost(spawned.expectedHost);
}

/**
 * Starts the Resources sampler for this daemon. Launches made before it started are replayed.
 * Records of new connections go to the same log as every other record.
 */
export function startDaemonResources(input: {
  home: string;
  onError: (error: unknown, message: string) => void;
}): ResourceMonitor {
  const monitor = new ResourceMonitor({
    home: input.home,
    onRecord: saveRecord,
    onError: input.onError,
  });
  resourceMonitor = monitor;
  for (const spawned of pendingSpawns.splice(0)) noteSpawn(monitor, spawned);
  monitor.start();
  return monitor;
}

export function getResourceMonitor(): ResourceMonitor | null {
  return resourceMonitor;
}

/** Folder, size, and file count of the daemon's saved records, or null when none are saved. */
export function getDaemonNetworkLogStats(): NetworkLogStats | null {
  return daemonLog?.stats() ?? null;
}

/** What a plugin process sends the daemon: the records it finished since its last batch. */
export interface ChildNetworkBatch {
  type: "pimi_network_batch";
  records: NetworkActivityRequest[];
  /** Records the plugin process had to drop because it produced more than it could send. */
  dropped: number;
}

const PLUGIN_BATCH_MS = 500;
const PLUGIN_BATCH_MAX = 200;
const PLUGIN_PROTOCOLS = new Set([
  "http",
  "https",
  "ws",
  "wss",
  "unix",
  "tcp",
  "udp",
  "dns",
  "process",
]);

export function isChildNetworkBatch(value: unknown): value is ChildNetworkBatch {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "pimi_network_batch" &&
    Array.isArray((value as { records?: unknown }).records)
  );
}

/**
 * Runs inside a plugin process, the one place plugin code makes its own requests. Everything
 * the process does through the same hooks as the daemon is batched to the daemon over IPC.
 * Returns a function that sends what is queued.
 */
export function startChildNetworkReporter(send: (batch: ChildNetworkBatch) => void): () => void {
  let queue: NetworkActivityRequest[] = [];
  let dropped = 0;
  const recorder = new NetworkActivityRecorder({
    idPrefix: "pl",
    capacity: 50,
    onFinish: (record) => {
      if (queue.length >= PLUGIN_BATCH_MAX) dropped += 1;
      else queue.push({ ...record });
    },
  });
  installNodeNetworkMonitor({ recorder, source: "daemon" });
  setProcessLaunchObserver(createProcessLaunchObserver(recorder, "daemon"));
  const flush = (): void => {
    if (queue.length === 0 && dropped === 0) return;
    const batch: ChildNetworkBatch = { type: "pimi_network_batch", records: queue, dropped };
    queue = [];
    dropped = 0;
    try {
      send(batch);
    } catch {
      // The daemon side of the channel is gone; the process is about to exit too.
    }
  };
  const timer = setInterval(flush, PLUGIN_BATCH_MS);
  timer.unref();
  return flush;
}

/**
 * Adds records a child process or worker thread reported. The daemon re-derives the host
 * classification and attributes the traffic to `purpose`; the sender's own labels are not trusted.
 */
export function ingestChildNetworkBatch(
  batch: ChildNetworkBatch,
  purpose: string = NETWORK_PURPOSE.plugins,
): void {
  const recorder = getDaemonNetworkActivity();
  const launches = processRecorder ?? recorder;
  for (const record of batch.records.slice(0, PLUGIN_BATCH_MAX)) {
    if (
      typeof record?.host !== "string" ||
      typeof record.protocol !== "string" ||
      !PLUGIN_PROTOCOLS.has(record.protocol)
    ) {
      continue;
    }
    (record.protocol === "process" ? launches : recorder).ingest({
      source: "daemon",
      method: String(record.method),
      protocol: record.protocol,
      host: record.host,
      port: typeof record.port === "number" ? record.port : null,
      path: maskPathSegments(String(record.path)),
      purpose,
      destination: typeof record.destination === "string" ? record.destination : null,
      status: typeof record.status === "number" ? record.status : null,
      errorCode: typeof record.errorCode === "string" ? record.errorCode : null,
      responseBytes: typeof record.responseBytes === "number" ? record.responseBytes : null,
      durationMs: typeof record.durationMs === "number" ? record.durationMs : null,
    });
  }
  if (batch.dropped > 0) {
    recorder.ingest({
      source: "daemon",
      method: "DROPPED",
      protocol: "https",
      host: "plugin-process",
      port: null,
      path: `/${batch.dropped}-records-not-reported`,
      purpose,
      errorCode: "DROPPED",
    });
  }
}

/**
 * Runs inside a worker thread. Diagnostics channels are per thread, so the thread installs its
 * own hooks and posts what they see to the thread that started it.
 */
export function startWorkerThreadNetworkReporter(): void {
  const port = parentPort;
  if (!port) return;
  startChildNetworkReporter((batch) => port.postMessage(batch));
}

/** Runs in the thread that started `worker`: folds the worker's reports into the daemon's records. */
export function observeWorkerThreadNetwork(worker: Worker, purpose: string): void {
  worker.on("message", (message: unknown) => {
    if (isChildNetworkBatch(message)) ingestChildNetworkBatch(message, purpose);
  });
}
