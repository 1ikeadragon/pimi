/**
 * Self-hosted Node relay.
 *
 * Implements relay wire protocol v2: `GET /ws?serverId=...&role=server|client&v=2[&connectionId=...]`.
 *
 * - role=server, no connectionId: daemon control socket (one per serverId)
 * - role=server, connectionId:    daemon per-connection data socket (one per connectionId)
 * - role=client:                  app socket (many per connectionId; the relay assigns an id if absent)
 *
 * The relay is untrusted: it pipes opaque frames between sockets of the same session and never
 * inspects, logs, or stores payloads. Protocol v1 (single socket pair) is not served.
 *
 * Run behind a TLS reverse proxy; it binds 127.0.0.1 by default.
 */

import { randomBytes, createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket, type RawData } from "ws";

type Role = "server" | "client";

export interface NodeRelayOptions {
  host: string;
  port: number;
  /** Max size of a single WebSocket message. */
  maxMessageBytes: number;
  /** Max distinct serverIds with at least one live socket. */
  maxSessions: number;
  /** Max live sockets across the whole process. */
  maxSockets: number;
  /** Max live sockets per client IP. */
  maxSocketsPerIp: number;
  /** Max new WebSocket upgrades per IP per minute. */
  maxUpgradesPerIpPerMinute: number;
  /** Max client sockets sharing one connectionId. */
  maxClientSocketsPerConnection: number;
  /** Frames buffered for a client whose daemon data socket has not connected yet. */
  maxPendingFrames: number;
  maxPendingBytes: number;
  /** Close a peer whose send buffer exceeds this (slow consumer). */
  maxBufferedBytes: number;
  /** WebSocket ping interval; a socket that misses a pong for one interval is terminated. */
  pingIntervalMs: number;
  /** Close data sockets (not daemon control sockets) that carried no frame for this long. 0 disables. */
  idleTimeoutMs: number;
  /** Honor X-Forwarded-For only when the TCP peer is loopback (the local reverse proxy). */
  trustProxy: boolean;
  log: (event: string, fields?: Record<string, string | number | boolean>) => void;
}

interface Frame {
  data: Buffer;
  isBinary: boolean;
}

interface Peer {
  ws: WebSocket;
  role: Role;
  /** null for the daemon control socket. */
  connectionId: string | null;
  ip: string;
  alive: boolean;
  lastFrameAt: number;
}

interface Session {
  control: Peer | null;
  servers: Map<string, Peer>;
  clients: Map<string, Set<Peer>>;
  pending: Map<string, { frames: Frame[]; bytes: number }>;
}

const MAX_ID_LENGTH = 128;
const ID_PATTERN = /^[\x21-\x7e]+$/;

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return value;
}

export function resolveNodeRelayOptionsFromEnv(): NodeRelayOptions {
  return {
    host: process.env.PIMI_RELAY_HOST?.trim() || "127.0.0.1",
    port: parseIntEnv("PIMI_RELAY_PORT", 8787),
    maxMessageBytes: parseIntEnv("PIMI_RELAY_MAX_MESSAGE_BYTES", 32 * 1024 * 1024),
    maxSessions: parseIntEnv("PIMI_RELAY_MAX_SESSIONS", 1000),
    maxSockets: parseIntEnv("PIMI_RELAY_MAX_SOCKETS", 4000),
    maxSocketsPerIp: parseIntEnv("PIMI_RELAY_MAX_SOCKETS_PER_IP", 100),
    maxUpgradesPerIpPerMinute: parseIntEnv("PIMI_RELAY_MAX_UPGRADES_PER_IP_PER_MINUTE", 120),
    maxClientSocketsPerConnection: parseIntEnv("PIMI_RELAY_MAX_CLIENT_SOCKETS_PER_CONNECTION", 8),
    maxPendingFrames: parseIntEnv("PIMI_RELAY_MAX_PENDING_FRAMES", 200),
    maxPendingBytes: parseIntEnv("PIMI_RELAY_MAX_PENDING_BYTES", 16 * 1024 * 1024),
    maxBufferedBytes: parseIntEnv("PIMI_RELAY_MAX_BUFFERED_BYTES", 64 * 1024 * 1024),
    pingIntervalMs: parseIntEnv("PIMI_RELAY_PING_INTERVAL_MS", 30_000),
    idleTimeoutMs: parseIntEnv("PIMI_RELAY_IDLE_TIMEOUT_MS", 30 * 60_000),
    trustProxy: process.env.PIMI_RELAY_TRUST_PROXY !== "0",
    log: defaultLog,
  };
}

function defaultLog(event: string, fields?: Record<string, string | number | boolean>): void {
  // Structured, payload-free. Never pass frame contents or full session ids here.
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`);
}

/** Short, non-reversible tag so logs can be correlated without exposing the session id. */
function tag(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function rawToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export interface NodeRelay {
  server: Server;
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

export function createNodeRelay(options: NodeRelayOptions): NodeRelay {
  const { log } = options;
  const sessions = new Map<string, Session>();
  const socketsPerIp = new Map<string, number>();
  const upgradeWindows = new Map<string, { windowStart: number; count: number }>();
  const peers = new Set<Peer>();

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxMessageBytes,
    perMessageDeflate: false,
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://relay.invalid");
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (url.pathname === "/ws") {
      res.writeHead(426, { "Content-Type": "text/plain" });
      res.end("Expected WebSocket upgrade");
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 15_000;

  function rejectUpgrade(socket: Duplex, status: number, message: string): void {
    socket.write(
      `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
    );
    socket.destroy();
  }

  function clientIp(req: IncomingMessage): string {
    const peerAddress = req.socket.remoteAddress;
    if (options.trustProxy && isLoopback(peerAddress)) {
      const forwarded = req.headers["x-forwarded-for"];
      const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
      if (first) return first;
    }
    return peerAddress ?? "unknown";
  }

  function allowUpgrade(ip: string): boolean {
    const now = Date.now();
    const entry = upgradeWindows.get(ip);
    if (!entry || now - entry.windowStart >= 60_000) {
      upgradeWindows.set(ip, { windowStart: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= options.maxUpgradesPerIpPerMinute;
  }

  function validId(value: string): boolean {
    return value.length > 0 && value.length <= MAX_ID_LENGTH && ID_PATTERN.test(value);
  }

  interface UpgradeRequest {
    serverId: string;
    role: Role;
    connectionId: string;
  }

  type UpgradeCheck = UpgradeRequest | { status: number; message: string };

  function parseUpgrade(url: URL): UpgradeCheck {
    const roleRaw = url.searchParams.get("role");
    const role: Role | null = roleRaw === "server" || roleRaw === "client" ? roleRaw : null;
    if (!role) return { status: 400, message: "Missing or invalid role parameter" };
    const serverId = url.searchParams.get("serverId");
    if (!serverId) return { status: 400, message: "Missing serverId parameter" };
    if (!validId(serverId)) return { status: 400, message: "Invalid serverId parameter" };
    if (url.searchParams.get("v")?.trim() !== "2") {
      return {
        status: 400,
        message: "Invalid v parameter (this relay serves protocol version 2 only)",
      };
    }
    const connectionIdRaw = (url.searchParams.get("connectionId") ?? "").trim();
    if (connectionIdRaw && !validId(connectionIdRaw)) {
      return { status: 400, message: "Invalid connectionId parameter" };
    }
    const connectionId =
      role === "client" && !connectionIdRaw
        ? `conn_${randomBytes(8).toString("hex")}`
        : connectionIdRaw;
    return { serverId, role, connectionId };
  }

  function capacityError(ip: string, request: UpgradeRequest): UpgradeCheck | null {
    if (peers.size >= options.maxSockets) {
      log("reject_max_sockets");
      return { status: 503, message: "Relay at capacity" };
    }
    if ((socketsPerIp.get(ip) ?? 0) >= options.maxSocketsPerIp) {
      log("reject_max_sockets_per_ip", { ip });
      return { status: 429, message: "Too many connections" };
    }
    if (!sessions.has(request.serverId) && sessions.size >= options.maxSessions) {
      log("reject_max_sessions");
      return { status: 503, message: "Relay at capacity" };
    }
    if (request.role === "client") {
      const existing = sessions.get(request.serverId)?.clients.get(request.connectionId);
      if (existing && existing.size >= options.maxClientSocketsPerConnection) {
        return { status: 429, message: "Too many sockets for this connection" };
      }
    }
    return null;
  }

  server.on("upgrade", (req, socket, head) => {
    const ip = clientIp(req);
    const url = new URL(req.url ?? "/", "http://relay.invalid");
    if (url.pathname !== "/ws") {
      rejectUpgrade(socket, 404, "Not found");
      return;
    }
    if (!allowUpgrade(ip)) {
      log("reject_rate_limited", { ip });
      rejectUpgrade(socket, 429, "Too many connections");
      return;
    }
    const parsed = parseUpgrade(url);
    if ("status" in parsed) {
      rejectUpgrade(socket, parsed.status, parsed.message);
      return;
    }
    const refused = capacityError(ip, parsed);
    if (refused && "status" in refused) {
      rejectUpgrade(socket, refused.status, refused.message);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      admit(ws, ip, parsed.serverId, parsed.role, parsed.connectionId);
    });
  });

  function getOrCreateSession(serverId: string): Session {
    let session = sessions.get(serverId);
    if (!session) {
      session = { control: null, servers: new Map(), clients: new Map(), pending: new Map() };
      sessions.set(serverId, session);
    }
    return session;
  }

  function dropSessionIfEmpty(serverId: string, session: Session): void {
    if (session.control || session.servers.size > 0 || session.clients.size > 0) return;
    sessions.delete(serverId);
  }

  function safeClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      ws.terminate();
    }
  }

  function forward(target: Peer, frame: Frame): boolean {
    if (target.ws.readyState !== WebSocket.OPEN) return false;
    if (target.ws.bufferedAmount > options.maxBufferedBytes) {
      log("close_slow_consumer", { role: target.role });
      safeClose(target.ws, 1008, "Slow consumer");
      return false;
    }
    try {
      target.ws.send(frame.data, { binary: frame.isBinary });
      return true;
    } catch {
      return false;
    }
  }

  function sendControl(session: Session, message: unknown): void {
    const control = session.control;
    if (!control) return;
    const text = JSON.stringify(message);
    try {
      control.ws.send(text);
    } catch {
      safeClose(control.ws, 1011, "Control send failed");
    }
  }

  function listConnectionIds(session: Session): string[] {
    return Array.from(session.clients.keys());
  }

  function bufferFrame(session: Session, connectionId: string, frame: Frame): void {
    const entry = session.pending.get(connectionId) ?? { frames: [], bytes: 0 };
    entry.frames.push(frame);
    entry.bytes += frame.data.length;
    // Bounded: a daemon that never connects must not grow memory without limit.
    while (
      entry.frames.length > options.maxPendingFrames ||
      (entry.bytes > options.maxPendingBytes && entry.frames.length > 1)
    ) {
      const dropped = entry.frames.shift();
      if (dropped) entry.bytes -= dropped.data.length;
    }
    session.pending.set(connectionId, entry);
  }

  function flushPending(session: Session, connectionId: string, serverPeer: Peer): void {
    const entry = session.pending.get(connectionId);
    if (!entry) return;
    session.pending.delete(connectionId);
    for (const frame of entry.frames) {
      if (!forward(serverPeer, frame)) break;
    }
  }

  function nudgeOrResetControl(serverId: string, connectionId: string): void {
    // Mirrors the Cloudflare adapter: if the daemon never opens the per-connection data socket,
    // resend the sync list once, then force the control socket to reconnect.
    const stillWaiting = (): Session | null => {
      const session = sessions.get(serverId);
      if (!session) return null;
      if (!session.clients.has(connectionId)) return null;
      if (session.servers.has(connectionId)) return null;
      return session;
    };
    const first = setTimeout(() => {
      const session = stillWaiting();
      if (!session) return;
      sendControl(session, { type: "sync", connectionIds: listConnectionIds(session) });
      const second = setTimeout(() => {
        const again = stillWaiting();
        if (!again?.control) return;
        safeClose(again.control.ws, 1011, "Control unresponsive");
      }, 5_000);
      second.unref();
    }, 10_000);
    first.unref();
  }

  function admit(
    ws: WebSocket,
    ip: string,
    serverId: string,
    role: Role,
    connectionId: string,
  ): void {
    const session = getOrCreateSession(serverId);
    const isControl = role === "server" && !connectionId;
    const peer: Peer = {
      ws,
      role,
      connectionId: connectionId || null,
      ip,
      alive: true,
      lastFrameAt: Date.now(),
    };

    if (isControl) {
      const old = session.control;
      session.control = peer;
      if (old) safeClose(old.ws, 1008, "Replaced by new connection");
    } else if (role === "server") {
      const old = session.servers.get(connectionId);
      session.servers.set(connectionId, peer);
      if (old) safeClose(old.ws, 1008, "Replaced by new connection");
    } else {
      let set = session.clients.get(connectionId);
      if (!set) {
        set = new Set();
        session.clients.set(connectionId, set);
      }
      set.add(peer);
    }

    peers.add(peer);
    socketsPerIp.set(ip, (socketsPerIp.get(ip) ?? 0) + 1);
    log("socket_open", {
      session: tag(serverId),
      role,
      kind: isControl ? "control" : "data",
    });

    ws.on("pong", () => {
      peer.alive = true;
    });

    ws.on("message", (data, isBinary) => {
      peer.lastFrameAt = Date.now();
      if (isControl) return;
      const frame: Frame = { data: rawToBuffer(data), isBinary };
      if (role === "client") {
        const target = session.servers.get(connectionId);
        if (!target) {
          bufferFrame(session, connectionId, frame);
          return;
        }
        forward(target, frame);
        return;
      }
      const targets = session.clients.get(connectionId);
      if (!targets) return;
      for (const target of targets) forward(target, frame);
    });

    ws.on("error", () => {
      // Errors (oversized message, protocol violation) are followed by close; nothing to add.
      log("socket_error", { session: tag(serverId), role });
    });

    ws.on("close", () => {
      peers.delete(peer);
      const remaining = (socketsPerIp.get(ip) ?? 1) - 1;
      if (remaining <= 0) socketsPerIp.delete(ip);
      else socketsPerIp.set(ip, remaining);
      log("socket_close", { session: tag(serverId), role });

      if (isControl) {
        if (session.control === peer) session.control = null;
      } else if (role === "server") {
        // Ignore sockets already replaced by a newer data socket for the same connection.
        if (session.servers.get(connectionId) === peer) {
          session.servers.delete(connectionId);
          // Force the client to reconnect and re-handshake when the daemon side drops.
          for (const client of session.clients.get(connectionId) ?? []) {
            safeClose(client.ws, 1012, "Server disconnected");
          }
        }
      } else {
        const set = session.clients.get(connectionId);
        set?.delete(peer);
        if (set && set.size === 0) {
          session.clients.delete(connectionId);
          session.pending.delete(connectionId);
          const serverPeer = session.servers.get(connectionId);
          if (serverPeer) safeClose(serverPeer.ws, 1001, "Client disconnected");
          sendControl(session, { type: "disconnected", connectionId });
        }
      }
      dropSessionIfEmpty(serverId, session);
    });

    if (role === "client") {
      sendControl(session, { type: "connected", connectionId });
      nudgeOrResetControl(serverId, connectionId);
    }
    if (isControl) {
      sendControl(session, { type: "sync", connectionIds: listConnectionIds(session) });
    }
    if (role === "server" && !isControl) {
      flushPending(session, connectionId, peer);
    }
  }

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of upgradeWindows) {
      if (now - entry.windowStart >= 60_000) upgradeWindows.delete(ip);
    }
    for (const peer of peers) {
      if (!peer.alive) {
        peer.ws.terminate();
        continue;
      }
      if (
        options.idleTimeoutMs > 0 &&
        peer.connectionId !== null &&
        now - peer.lastFrameAt > options.idleTimeoutMs
      ) {
        safeClose(peer.ws, 1001, "Idle timeout");
        continue;
      }
      peer.alive = false;
      try {
        peer.ws.ping();
      } catch {
        peer.ws.terminate();
      }
    }
  }, options.pingIntervalMs);
  sweep.unref();

  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, options.host, () => {
          server.off("error", reject);
          const address = server.address();
          if (address && typeof address === "object") {
            resolve({ host: address.address, port: address.port });
          } else {
            resolve({ host: options.host, port: options.port });
          }
        });
      });
    },
    close() {
      clearInterval(sweep);
      for (const peer of peers) peer.ws.terminate();
      wss.close();
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

async function main(): Promise<void> {
  const options = resolveNodeRelayOptionsFromEnv();
  const relay = createNodeRelay(options);
  const address = await relay.listen();
  options.log("listening", { host: address.host, port: address.port });

  const shutdown = (signal: string): void => {
    options.log("shutdown", { signal });
    void relay.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `relay failed to start: ${error instanceof Error ? error.message : "unknown"}\n`,
    );
    process.exit(1);
  });
}
