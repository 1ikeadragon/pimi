import { AsyncLocalStorage } from "node:async_hooks";
import diagnosticsChannel from "node:diagnostics_channel";
import type { ClientRequest, IncomingMessage } from "node:http";
import {
  NetworkActivityRecorder,
  type NetworkActivityStartInput,
} from "@pimi/protocol/network-activity";
import type { NetworkActivityRequest } from "@pimi/protocol/messages";

// Outbound request observation through Node's built-in diagnostics channels. It sees global
// fetch (undici, including requests through the proxy dispatcher) and node:http/https, which
// also carries ws WebSocket handshakes. It does not see child processes (agent providers,
// plugin processes, terminals) or raw net/tls sockets.

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

/** The daemon's process-wide recorder. Installed once by the daemon worker at startup. */
export function getDaemonNetworkActivity(): NetworkActivityRecorder {
  if (!daemonRecorder) {
    daemonRecorder = new NetworkActivityRecorder({ idPrefix: "d", capacity: 1000 });
    installNodeNetworkMonitor({ recorder: daemonRecorder, source: "daemon" });
  }
  return daemonRecorder;
}
