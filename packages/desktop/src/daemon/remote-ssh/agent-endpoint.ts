import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import { resolvePimiHome } from "@pimi/server/daemon-control";
import {
  DEFAULT_SSH_DAEMON_PORT,
  validatePort,
  validateSshHost,
} from "@pimi/protocol/ssh-transport";
import { startSshTunnel, type SshTransportTarget, type SshTunnel } from "../local-transport.js";

// macOS sun_path is 104 bytes including the terminator.
const MAX_SOCKET_PATH_BYTES = 100;

interface AgentEndpoint {
  connection: string;
  socketPath: string | null;
  server: Server;
  sockets: Set<Socket>;
  tunnels: Set<SshTunnel>;
}

const endpoints = new Map<string, AgentEndpoint>();
const pending = new Map<string, Promise<string>>();

function parseTarget(value: unknown): SshTransportTarget {
  if (typeof value !== "object" || value === null) {
    throw new Error("Remote SSH target is required.");
  }
  const record = value as Record<string, unknown>;
  return {
    transportType: "ssh",
    host: validateSshHost(typeof record.host === "string" ? record.host : ""),
    ...(typeof record.sshPort === "number"
      ? { sshPort: validatePort(record.sshPort, "SSH port") }
      : {}),
    ...(typeof record.daemonPort === "number"
      ? { daemonPort: validatePort(record.daemonPort, "Daemon port") }
      : {}),
  };
}

function targetKey(target: SshTransportTarget): string {
  return `${target.host}|${target.sshPort ?? ""}|${target.daemonPort ?? DEFAULT_SSH_DAEMON_PORT}`;
}

function targetHash(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

function resolveEndpointPath(key: string): { listenPath: string; connection: string } {
  const hash = targetHash(key);
  if (process.platform === "win32") {
    const pipe = `\\\\.\\pipe\\pimi-ssh-${hash}`;
    return { listenPath: pipe, connection: `pipe://${pipe}` };
  }
  const home = resolvePimiHome(process.env);
  let socketPath = path.join(home, "run", `ssh-${hash}.sock`);
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    // A deep PIMI_HOME (a worktree's .dev home, a scratch dir) cannot hold a unix socket. Fall back to
    // a short private directory keyed by user and home; the caller still creates it 0700 and chmods it.
    const uid = process.getuid?.() ?? 0;
    const homeKey = createHash("sha256").update(home).digest("hex").slice(0, 8);
    socketPath = path.join("/tmp", `pimi-${uid}-${homeKey}`, `ssh-${hash}.sock`);
  }
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    throw new Error(
      `Socket path is too long (${Buffer.byteLength(socketPath)} bytes, limit ${MAX_SOCKET_PATH_BYTES}): ${socketPath}`,
    );
  }
  return { listenPath: socketPath, connection: `unix://${socketPath}` };
}

function unlinkQuietly(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // Missing file is the normal case.
  }
}

function listen(target: SshTransportTarget, key: string): Promise<string> {
  const { listenPath, connection } = resolveEndpointPath(key);
  const isPipe = process.platform === "win32";
  if (!isPipe) {
    mkdirSync(path.dirname(listenPath), { recursive: true, mode: 0o700 });
    // mkdir does not change the mode of an existing directory.
    chmodSync(path.dirname(listenPath), 0o700);
    unlinkQuietly(listenPath);
  }
  const sockets = new Set<Socket>();
  const tunnels = new Set<SshTunnel>();
  const server = createServer((accepted) => {
    sockets.add(accepted);
    const tunnel = startSshTunnel(target, accepted);
    tunnels.add(tunnel);
    accepted.once("close", () => {
      sockets.delete(accepted);
      tunnels.delete(tunnel);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPath, () => {
      server.off("error", reject);
      server.on("error", () => undefined);
      if (!isPipe) {
        try {
          chmodSync(listenPath, 0o600);
        } catch (error) {
          server.close();
          unlinkQuietly(listenPath);
          reject(error);
          return;
        }
      }
      endpoints.set(key, {
        connection,
        socketPath: isPipe ? null : listenPath,
        server,
        sockets,
        tunnels,
      });
      resolve(connection);
    });
  });
}

/**
 * IPC: a local socket (unix) or named pipe (Windows) whose every connection is one `ssh -W` tunnel
 * to the remote daemon. Idempotent per target. It does not install or start the remote daemon; the
 * app's own connection to that host does that on every connect.
 */
export function ensureSshAgentEndpoint(args: unknown): Promise<string> {
  const target = parseTarget(args);
  const key = targetKey(target);
  const existing = endpoints.get(key);
  if (existing) return Promise.resolve(existing.connection);
  const inflight = pending.get(key);
  if (inflight) return inflight;
  const started = listen(target, key).finally(() => pending.delete(key));
  pending.set(key, started);
  return started;
}

function closeEndpoint(key: string, endpoint: AgentEndpoint): void {
  endpoints.delete(key);
  endpoint.server.close();
  for (const tunnel of endpoint.tunnels) tunnel.kill();
  for (const socket of endpoint.sockets) socket.destroy();
  if (endpoint.socketPath) unlinkQuietly(endpoint.socketPath);
}

/** IPC: close the listener for a target, kill its tunnels and unlink the socket file. */
export async function closeSshAgentEndpoint(args: unknown): Promise<void> {
  const key = targetKey(parseTarget(args));
  // A close that races an in-flight ensure waits for it, then closes what it created.
  await pending.get(key)?.catch(() => undefined);
  const endpoint = endpoints.get(key);
  if (endpoint) closeEndpoint(key, endpoint);
}

export function closeAllSshAgentEndpoints(): void {
  for (const [key, endpoint] of endpoints) closeEndpoint(key, endpoint);
}
