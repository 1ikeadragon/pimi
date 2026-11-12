import { AsyncLocalStorage } from "node:async_hooks";
import diagnosticsChannel from "node:diagnostics_channel";
import type { ClientRequest, IncomingMessage } from "node:http";
import {
  NetworkActivityRecorder,
  type NetworkActivitySnapshotOptions,
  type NetworkActivityStartInput,
} from "@pimi/protocol/network-activity";
import type { NetworkActivityRequest, NetworkActivitySnapshot } from "@pimi/protocol/messages";
import { setProcessLaunchObserver } from "../../utils/process-launch.js";
import { NetworkLogStore, type NetworkLogSettings, type NetworkLogStats } from "./log-store.js";
import { createProcessLaunchObserver } from "./process-launch-recorder.js";

// Outbound request observation through Node's built-in diagnostics channels. It sees global
// fetch (undici, including requests through the proxy dispatcher) and node:http/https, which
// also carries ws WebSocket handshakes. It does not see inside child processes (agent
// providers, git, gh, language servers, plugins, terminals) or raw net/tls sockets; launches of
// the ones that matter are recorded separately through the process launch observer.

const initiator = new AsyncLocalStorage<string>();

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
    path: request.path ?? "/",
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
    path: request.path,
    purpose: initiator.getStore() ?? null,
  };
}

function contentLength(response: IncomingMessage | null | undefined): number | null {
  const header = response?.headers["content-length"];
  if (typeof header !== "string" || !/^\d+$/.test(header)) return null;
  return Number(header);
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

  const handlers: Array<[string, (message: unknown) => void]> = [
    [
      "undici:request:create",
      (message) => {
        const { request } = message as UndiciRequestMessage;
        const start = undiciStart(request, source);
        if (start) undiciRecords.set(request, recorder.start(start));
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
        const record = recorder.start(httpStart(request, source));
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

  for (const [name, handler] of handlers) diagnosticsChannel.subscribe(name, handler);
  return () => {
    for (const [name, handler] of handlers) diagnosticsChannel.unsubscribe(name, handler);
  };
}

let daemonRecorder: NetworkActivityRecorder | null = null;
let processRecorder: NetworkActivityRecorder | null = null;
let daemonLog: NetworkLogStore | null = null;

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
      onFinish: (record) => daemonLog?.append(record),
    });
    installNodeNetworkMonitor({ recorder: daemonRecorder, source: "daemon" });
    processRecorder = new NetworkActivityRecorder({
      idPrefix: "p",
      capacity: 1000,
      onFinish: (record) => daemonLog?.append(record),
    });
    setProcessLaunchObserver(createProcessLaunchObserver(processRecorder, "daemon"));
  }
  return daemonRecorder;
}

/** Requests and launched programs together, newest first, as the Network tab shows them. */
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
  return store;
}

/** Folder, size, and file count of the daemon's saved records, or null when none are saved. */
export function getDaemonNetworkLogStats(): NetworkLogStats | null {
  return daemonLog?.stats() ?? null;
}
