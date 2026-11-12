import type { IncomingMessage, ServerResponse } from "node:http";
import { NETWORK_PURPOSE, type NetworkActivityRecorder } from "@pimi/protocol/network-activity";
import type { NetworkActivityRequest } from "@pimi/protocol/messages";
import { maskPathSegments } from "./redact.js";

// Requests and WebSocket connections that reach the daemon. Only the method, the peer address,
// and the path with credential-shaped segments masked are kept: never the query string,
// headers, or bodies, and never WebSocket message contents.

function peerAddress(request: Pick<IncomingMessage, "socket">): string {
  const address = request.socket?.remoteAddress ?? "";
  return address.replace(/^::ffff:/, "");
}

export type InboundHttpMiddleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
) => void;

export function createInboundHttpActivityMiddleware(
  getRecorder: () => NetworkActivityRecorder,
): InboundHttpMiddleware {
  return (request, response, next) => {
    const recorder = getRecorder();
    const record = recorder.start({
      source: "daemon",
      method: request.method ?? "GET",
      protocol: "http",
      host: peerAddress(request),
      port: null,
      path: maskPathSegments(request.url ?? "/"),
      purpose: NETWORK_PURPOSE.inbound,
    });
    response.once("close", () => {
      const length = response.getHeader("content-length");
      const bytes = typeof length === "string" || typeof length === "number" ? Number(length) : NaN;
      recorder.finish(record, {
        status: response.writableFinished ? response.statusCode : null,
        errorCode: response.writableFinished ? null : "ABORTED",
        responseBytes: Number.isFinite(bytes) ? bytes : null,
      });
    });
    next();
  };
}

export interface InboundSocketOrigin {
  /** "relay" and "lan" sockets are carried by another transport and have no peer address. */
  transport?: "relay" | "lan";
  remoteAddress?: string;
}

/** Counts one WebSocket connection's traffic and writes its record when it closes. */
export class InboundSocketActivity {
  private messagesIn = 0;
  private bytesIn = 0;
  private messagesOut = 0;
  private bytesOut = 0;
  private readonly record: NetworkActivityRequest;

  constructor(
    private readonly recorder: NetworkActivityRecorder,
    origin: InboundSocketOrigin,
  ) {
    this.record = recorder.start({
      source: "daemon",
      method: "WS",
      protocol: "ws",
      host: origin.transport ?? origin.remoteAddress?.replace(/^::ffff:/, "") ?? "",
      port: null,
      path: "/ws",
      purpose: NETWORK_PURPOSE.inbound,
    });
  }

  received(bytes: number): void {
    this.messagesIn += 1;
    this.bytesIn += bytes;
  }

  sent(bytes: number): void {
    this.messagesOut += 1;
    this.bytesOut += bytes;
  }

  close(details: { code?: number; error?: Error }): void {
    this.recorder.finish(this.record, {
      status: 101,
      errorCode: details.error ? ((details.error as NodeJS.ErrnoException).code ?? "ERROR") : null,
      responseBytes: this.bytesOut,
      counters: {
        messagesIn: this.messagesIn,
        bytesIn: this.bytesIn,
        messagesOut: this.messagesOut,
        bytesOut: this.bytesOut,
        ...(details.code !== undefined ? { closeCode: details.code } : {}),
      },
    });
  }
}
