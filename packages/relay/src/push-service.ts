/**
 * Pimi push service: relays fixed-text Android notifications to FCM.
 *
 * Runs as its own process behind the TLS reverse proxy (`handle /push/*`), separate from the
 * relay so the relay keeps its no-credentials, no-egress sandbox. It holds the only Google
 * service-account key. Clients hold an opaque 256-bit handle bound to one serverId; the service
 * stores only SHA-256(handle) next to the FCM token and never forwards free-form text.
 *
 * - POST /push/register   {token, serverId, handle?} -> {handle}   (handle present rotates the token)
 * - POST /push/send       {handle, kind, id}         -> {ok}       (410 = handle gone, prune it)
 * - POST /push/unregister {handle}                   -> {ok}
 *
 * Google hosts are hardcoded; token_uri from the key file is ignored; redirects are refused.
 * Logs carry an event name and a short hash tag only: never tokens, handles, keys or FCM bodies.
 */

import {
  createHash,
  createPrivateKey,
  randomBytes,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const FCM_HOST = "https://fcm.googleapis.com";
const UPSTREAM_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 2048;
const ACCESS_TOKEN_MAX_AGE_MS = 55 * 60_000;
const ACCESS_TOKEN_REFRESH_MARGIN_MS = 60_000;
const DAY_MS = 86_400_000;
// One FCM token (one install) may hold a few handles, one per paired host; more is abuse.
const MAX_HANDLES_PER_TOKEN = 8;

const HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_:.-]{20,1024}$/;
const SERVER_ID_PATTERN = /^[\w.-]{1,128}$/;
const ID_PATTERN = /^[\w-]{1,128}$/;
const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{3,62}$/;

export type PushKind = "agent_finished" | "agent_permission" | "terminal";

const KIND_BODIES: Record<PushKind, { body: string; reason: string; tagPrefix: string }> = {
  agent_finished: { body: "An agent finished.", reason: "finished", tagPrefix: "agent" },
  agent_permission: {
    body: "An agent needs your approval.",
    reason: "permission",
    tagPrefix: "agent",
  },
  terminal: {
    body: "A terminal needs your attention.",
    reason: "attention",
    tagPrefix: "terminal",
  },
};

export interface PushServiceOptions {
  host: string;
  port: number;
  storePath: string;
  serviceAccountPath: string;
  maxEntries: number;
  entryTtlMs: number;
  registerPerIpPerHour: number;
  unregisterPerIpPerHour: number;
  sendPerIpPerMinute: number;
  sendPerHandlePer10Min: number;
  /** FCM calls (sends and register validations) allowed per UTC day across the process. */
  dailyFcmLimit: number;
  trustProxy: boolean;
  log: (event: string, fields?: Record<string, string | number | boolean>) => void;
}

interface HandleEntry {
  serverId: string;
  token: string;
  createdAt: number;
  renewedAt: number;
}

interface StoreFile {
  version: 1;
  entries: Record<string, HandleEntry>;
}

interface ServiceAccount {
  clientEmail: string;
  privateKey: KeyObject;
  projectId: string;
}

type FcmResult = "ok" | "unregistered" | "invalid" | "upstream" | "limit";

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Short, non-reversible tag so logs can be correlated without exposing the handle. */
function tag(value: string): string {
  return sha256Hex(value).slice(0, 8);
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/** Rate-limit key: IPv4 as is, IPv6 by /64 so one customer's whole prefix shares a budget. */
function limiterKey(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return mapped[1] as string;
  if (!address.includes(":")) return address;
  const [head = "", tail = ""] = address.split("::", 2);
  const headGroups = head === "" ? [] : head.split(":");
  const tailGroups = address.includes("::") && tail !== "" ? tail.split(":") : [];
  const groups = address.includes("::")
    ? [
        ...headGroups,
        ...Array(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill("0"),
        ...tailGroups,
      ]
    : headGroups;
  return `${groups
    .slice(0, 4)
    .map((group) => group.toLowerCase().padStart(4, "0"))
    .join(":")}::/64`;
}

function base64Url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function defaultLog(event: string, fields?: Record<string, string | number | boolean>): void {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`);
}

function defaultServiceAccountPath(): string {
  const credentials = process.env.CREDENTIALS_DIRECTORY;
  return credentials ? path.join(credentials, "fcm-sa.json") : "/etc/pimi-push/fcm-sa.json";
}

export function resolvePushServiceOptionsFromEnv(): PushServiceOptions {
  return {
    host: process.env.PIMI_PUSH_HOST?.trim() || "127.0.0.1",
    port: parseIntEnv("PIMI_PUSH_PORT", 8788),
    storePath: process.env.PIMI_PUSH_STORE?.trim() || "/var/lib/pimi-push/handles.json",
    serviceAccountPath:
      process.env.PIMI_PUSH_SERVICE_ACCOUNT?.trim() || defaultServiceAccountPath(),
    maxEntries: parseIntEnv("PIMI_PUSH_MAX_ENTRIES", 5000),
    entryTtlMs: parseIntEnv("PIMI_PUSH_ENTRY_TTL_DAYS", 60) * DAY_MS,
    registerPerIpPerHour: parseIntEnv("PIMI_PUSH_REGISTER_PER_IP_PER_HOUR", 10),
    unregisterPerIpPerHour: parseIntEnv("PIMI_PUSH_UNREGISTER_PER_IP_PER_HOUR", 60),
    sendPerIpPerMinute: parseIntEnv("PIMI_PUSH_SEND_PER_IP_PER_MINUTE", 60),
    sendPerHandlePer10Min: parseIntEnv("PIMI_PUSH_SEND_PER_HANDLE_PER_10_MIN", 30),
    dailyFcmLimit: parseIntEnv("PIMI_PUSH_DAILY_FCM_LIMIT", 20_000),
    trustProxy: process.env.PIMI_PUSH_TRUST_PROXY !== "0",
    log: defaultLog,
  };
}

function loadServiceAccount(filePath: string): ServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw new Error("service account file is missing or not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("service account file is not a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const { client_email: clientEmail, private_key: privateKey, project_id: projectId } = record;
  if (typeof clientEmail !== "string" || clientEmail.length === 0) {
    throw new Error("service account client_email is missing");
  }
  if (typeof projectId !== "string" || !PROJECT_ID_PATTERN.test(projectId)) {
    throw new Error("service account project_id is missing or malformed");
  }
  if (typeof privateKey !== "string") {
    throw new Error("service account private_key is missing");
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(privateKey);
  } catch {
    throw new Error("service account private_key is not a valid key");
  }
  if (key.asymmetricKeyType !== "rsa") {
    throw new Error("service account private_key is not an RSA key");
  }
  return { clientEmail, privateKey: key, projectId };
}

function loadStore(filePath: string, log: PushServiceOptions["log"]): Map<string, HandleEntry> {
  const entries = new Map<string, HandleEntry>();
  if (!existsSync(filePath)) return entries;
  const raw = readFileSync(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("handle store is not valid JSON");
  }
  const file = parsed as Partial<StoreFile> | null;
  if (!file || file.version !== 1 || typeof file.entries !== "object" || file.entries === null) {
    throw new Error("handle store has an unknown format");
  }
  for (const [hash, entry] of Object.entries(file.entries)) {
    if (
      /^[0-9a-f]{64}$/.test(hash) &&
      typeof entry?.token === "string" &&
      typeof entry.serverId === "string" &&
      Number.isFinite(entry.createdAt) &&
      Number.isFinite(entry.renewedAt)
    ) {
      entries.set(hash, entry);
    }
  }
  log("store_loaded", { entries: entries.size });
  return entries;
}

// Same contract as the daemon's private-files.ts: temp file created 0600, renamed into place.
function writeStore(filePath: string, entries: Map<string, HandleEntry>): void {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString("hex")}`,
  );
  const file: StoreFile = { version: 1, entries: Object.fromEntries(entries) };
  try {
    writeFileSync(temporary, JSON.stringify(file), { mode: 0o600 });
    renameSync(temporary, filePath);
    chmodSync(filePath, 0o600);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

class FixedWindowLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly windowMs: number,
    private readonly limit: number,
  ) {}

  allow(key: string, now: number): boolean {
    const entry = this.windows.get(key);
    if (!entry || now - entry.start >= this.windowMs) {
      if (this.windows.size >= 10_000) this.prune(now);
      this.windows.set(key, { start: now, count: 1 });
      return this.limit >= 1;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.windows) {
      if (now - entry.start >= this.windowMs) this.windows.delete(key);
    }
    // Still full of live windows (distributed flood): drop the oldest rather than grow unbounded.
    if (this.windows.size >= 10_000) {
      const oldest = this.windows.keys().next().value;
      if (oldest !== undefined) this.windows.delete(oldest);
    }
  }
}

async function readJsonBody(
  req: IncomingMessage,
  allowedKeys: readonly string[],
): Promise<Record<string, unknown>> {
  if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "unsupported_media_type");
  }
  const declared = req.headers["content-length"];
  if (declared !== undefined && Number(declared) > MAX_BODY_BYTES) {
    throw new HttpError(413, "body_too_large");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new HttpError(413, "body_too_large");
    chunks.push(buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "invalid_body");
  }
  const body = parsed as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!allowedKeys.includes(key)) throw new HttpError(400, "unknown_field");
  }
  return body;
}

function requireString(body: Record<string, unknown>, key: string, pattern: RegExp): string {
  const value = body[key];
  if (typeof value !== "string" || !pattern.test(value)) throw new HttpError(400, `invalid_${key}`);
  return value;
}

export interface PushService {
  server: Server;
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

export function createPushService(options: PushServiceOptions): PushService {
  const { log } = options;
  const account = loadServiceAccount(options.serviceAccountPath);
  const entries = loadStore(options.storePath, log);
  const registerLimiter = new FixedWindowLimiter(3_600_000, options.registerPerIpPerHour);
  const unregisterLimiter = new FixedWindowLimiter(3_600_000, options.unregisterPerIpPerHour);
  const sendIpLimiter = new FixedWindowLimiter(60_000, options.sendPerIpPerMinute);
  const sendHandleLimiter = new FixedWindowLimiter(600_000, options.sendPerHandlePer10Min);
  const fcmSendUrl = `${FCM_HOST}/v1/projects/${account.projectId}/messages:send`;

  let accessToken: { value: string; expiresAt: number } | null = null;
  let accessTokenRequest: Promise<string> | null = null;
  let fcmDay = Math.floor(Date.now() / DAY_MS);
  let fcmCallsToday = 0;
  let validationsToday = 0;

  function persist(): void {
    writeStore(options.storePath, entries);
  }

  function purgeExpired(now: number): void {
    let removed = 0;
    for (const [hash, entry] of entries) {
      if (now - entry.renewedAt > options.entryTtlMs) {
        entries.delete(hash);
        removed += 1;
      }
    }
    if (removed > 0) {
      persist();
      log("store_purged", { removed });
    }
  }

  function clientIp(req: IncomingMessage): string {
    const peer = req.socket.remoteAddress;
    if (options.trustProxy && isLoopback(peer)) {
      // Caddy appends the real peer last; earlier entries are client-supplied.
      const forwarded = req.headers["x-forwarded-for"];
      const header = Array.isArray(forwarded) ? forwarded[forwarded.length - 1] : forwarded;
      const last = header?.split(",").pop()?.trim();
      if (last && isIP(last) !== 0) return limiterKey(last);
    }
    return peer ? limiterKey(peer) : "unknown";
  }

  function takeFcmBudget(now: number, validateOnly: boolean): boolean {
    const day = Math.floor(now / DAY_MS);
    if (day !== fcmDay) {
      fcmDay = day;
      fcmCallsToday = 0;
      validationsToday = 0;
    }
    if (fcmCallsToday >= options.dailyFcmLimit) return false;
    // Registrations validate tokens with Google; a tenth of the budget keeps a register flood from
    // starving sends.
    if (validateOnly && validationsToday >= Math.ceil(options.dailyFcmLimit / 10)) return false;
    if (validateOnly) validationsToday += 1;
    fcmCallsToday += 1;
    return true;
  }

  async function upstreamFetch(url: string, init: RequestInit): Promise<Response> {
    return await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  }

  async function requestAccessToken(): Promise<string> {
    const issuedAt = Math.floor(Date.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64Url(
      JSON.stringify({
        iss: account.clientEmail,
        scope: FCM_SCOPE,
        aud: OAUTH_TOKEN_URL,
        iat: issuedAt,
        exp: issuedAt + 3600,
      }),
    );
    const unsigned = `${header}.${claims}`;
    const signature = base64Url(
      cryptoSign("RSA-SHA256", Buffer.from(unsigned), account.privateKey),
    );
    const response = await upstreamFetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature}`,
      }),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`oauth status ${response.status}`);
    }
    const parsed = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
      throw new Error("oauth response without access token");
    }
    const lifetimeMs =
      typeof parsed.expires_in === "number" ? parsed.expires_in * 1000 : ACCESS_TOKEN_MAX_AGE_MS;
    accessToken = {
      value: parsed.access_token,
      expiresAt:
        Date.now() +
        Math.max(0, Math.min(ACCESS_TOKEN_MAX_AGE_MS, lifetimeMs - ACCESS_TOKEN_REFRESH_MARGIN_MS)),
    };
    return accessToken.value;
  }

  async function getAccessToken(): Promise<string> {
    if (accessToken && Date.now() < accessToken.expiresAt) return accessToken.value;
    accessTokenRequest ??= requestAccessToken().finally(() => {
      accessTokenRequest = null;
    });
    return await accessTokenRequest;
  }

  /** Classify an FCM error body without ever logging or returning it. */
  async function fcmErrorCode(response: Response): Promise<string | null> {
    try {
      const parsed = (await response.json()) as {
        error?: { status?: unknown; details?: Array<{ errorCode?: unknown }> };
      };
      const detail = parsed.error?.details?.find((item) => typeof item?.errorCode === "string");
      if (typeof detail?.errorCode === "string") return detail.errorCode;
      return typeof parsed.error?.status === "string" ? parsed.error.status : null;
    } catch {
      return null;
    }
  }

  async function callFcm(
    message: Record<string, unknown>,
    validateOnly: boolean,
  ): Promise<FcmResult> {
    if (!takeFcmBudget(Date.now(), validateOnly)) {
      log("fcm_daily_limit");
      return "limit";
    }
    try {
      const bearer = await getAccessToken();
      const response = await upstreamFetch(fcmSendUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ validate_only: validateOnly, message }),
      });
      if (response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return "ok";
      }
      if (response.status === 401) accessToken = null;
      const code = await fcmErrorCode(response);
      if (code === "UNREGISTERED") return "unregistered";
      if (response.status === 400 || code === "INVALID_ARGUMENT") return "invalid";
      log("fcm_error", { status: response.status });
      return "upstream";
    } catch {
      // Network, timeout, redirect, or oauth failure: details can echo secrets, so drop them.
      log("fcm_unreachable");
      return "upstream";
    }
  }

  function json(res: ServerResponse, status: number, body: Record<string, unknown>): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
      "cache-control": "no-store",
    });
    res.end(payload);
  }

  function rotateHandle(hash: string, handle: string, token: string, now: number) {
    // An unregister may have landed while Google was validating the token.
    const current = entries.get(hash);
    if (!current) throw new HttpError(410, "unknown_handle");
    entries.set(hash, { ...current, token, renewedAt: now });
    persist();
    log("register_rotated", { handle: tag(handle) });
    return { handle };
  }

  async function handleRegister(
    req: IncomingMessage,
    ip: string,
  ): Promise<Record<string, unknown>> {
    if (!registerLimiter.allow(ip, Date.now())) throw new HttpError(429, "rate_limited");
    const body = await readJsonBody(req, ["token", "serverId", "handle"]);
    const token = requireString(body, "token", TOKEN_PATTERN);
    const serverId = requireString(body, "serverId", SERVER_ID_PATTERN);
    const existingHandle =
      body.handle === undefined ? null : requireString(body, "handle", HANDLE_PATTERN);
    const now = Date.now();
    const existingHash = existingHandle ? sha256Hex(existingHandle) : null;
    const existing = existingHash ? entries.get(existingHash) : undefined;
    if (existingHash && (!existing || existing.serverId !== serverId)) {
      throw new HttpError(410, "unknown_handle");
    }
    if (!existing) {
      purgeExpired(now);
      if (entries.size >= options.maxEntries) throw new HttpError(503, "store_full");
    }

    const verdict = await callFcm({ token, data: { ping: "1" } }, true);
    if (verdict === "invalid" || verdict === "unregistered")
      throw new HttpError(400, "invalid_token");
    if (verdict === "limit") throw new HttpError(503, "unavailable");
    if (verdict !== "ok") throw new HttpError(502, "upstream_error");

    if (existingHash && existing)
      return rotateHandle(existingHash, existingHandle as string, token, now);
    // The same install pairing with the same host again replaces its old handle, and one token
    // never accumulates more than a few handles (oldest evicted).
    const sameToken: Array<[string, HandleEntry]> = [];
    for (const [hash, entry] of entries) {
      if (entry.token !== token) continue;
      if (entry.serverId === serverId) entries.delete(hash);
      else sameToken.push([hash, entry]);
    }
    sameToken.sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (const [hash] of sameToken.slice(
      0,
      Math.max(0, sameToken.length - MAX_HANDLES_PER_TOKEN + 1),
    )) {
      entries.delete(hash);
    }
    const handle = randomBytes(32).toString("base64url");
    entries.set(sha256Hex(handle), { serverId, token, createdAt: now, renewedAt: now });
    persist();
    log("register_created", { handle: tag(handle), entries: entries.size });
    return { handle };
  }

  async function handleSend(req: IncomingMessage, ip: string): Promise<Record<string, unknown>> {
    if (!sendIpLimiter.allow(ip, Date.now())) throw new HttpError(429, "rate_limited");
    const body = await readJsonBody(req, ["handle", "kind", "id"]);
    const handle = requireString(body, "handle", HANDLE_PATTERN);
    const kind = body.kind;
    if (typeof kind !== "string" || !Object.prototype.hasOwnProperty.call(KIND_BODIES, kind)) {
      throw new HttpError(400, "invalid_kind");
    }
    const id = requireString(body, "id", ID_PATTERN);
    const hash = sha256Hex(handle);
    const entry = entries.get(hash);
    const now = Date.now();
    if (!entry || now - entry.renewedAt > options.entryTtlMs) {
      if (entry) {
        entries.delete(hash);
        persist();
      }
      throw new HttpError(410, "unknown_handle");
    }
    if (!sendHandleLimiter.allow(sha256Hex(entry.token), now))
      throw new HttpError(429, "rate_limited");

    const spec = KIND_BODIES[kind as PushKind];
    const notificationTag = `${spec.tagPrefix}:${id}`;
    const target = spec.tagPrefix === "agent" ? { agentId: id } : { terminalId: id };
    const result = await callFcm(
      {
        token: entry.token,
        notification: { title: "Pimi", body: spec.body },
        data: {
          tag: notificationTag,
          // expo-notifications reads this JSON string as the notification's `data`.
          body: JSON.stringify({ serverId: entry.serverId, ...target, reason: spec.reason }),
        },
        android: {
          priority: "HIGH",
          ttl: "3600s",
          collapse_key: notificationTag,
          // Same small icon and colour as local notifications (app.config.js), and the app (not
          // Play services) posts it.
          notification: {
            channel_id: "agent-activity",
            tag: notificationTag,
            icon: "notification_icon",
            color: "#20744A",
            proxy: "DENY",
          },
        },
      },
      false,
    );
    if (result === "unregistered") {
      entries.delete(hash);
      persist();
      log("send_unregistered", { handle: tag(handle) });
      throw new HttpError(410, "unregistered");
    }
    if (result === "limit") throw new HttpError(503, "unavailable");
    if (result !== "ok") throw new HttpError(502, "upstream_error");
    log("send_ok", { handle: tag(handle), kind });
    return { ok: true };
  }

  async function handleUnregister(
    req: IncomingMessage,
    ip: string,
  ): Promise<Record<string, unknown>> {
    if (!unregisterLimiter.allow(ip, Date.now())) throw new HttpError(429, "rate_limited");
    const body = await readJsonBody(req, ["handle"]);
    const handle = requireString(body, "handle", HANDLE_PATTERN);
    if (entries.delete(sha256Hex(handle))) {
      persist();
      log("unregister", { handle: tag(handle) });
    }
    // Idempotent: an unknown handle is already unregistered.
    return { ok: true };
  }

  const routes: Record<
    string,
    (req: IncomingMessage, ip: string) => Promise<Record<string, unknown>>
  > = {
    "/push/register": handleRegister,
    "/push/send": handleSend,
    "/push/unregister": handleUnregister,
  };

  const server = createServer((req, res) => {
    const route = Object.prototype.hasOwnProperty.call(routes, req.url ?? "")
      ? routes[req.url as string]
      : undefined;
    if (!route) {
      json(res, 404, { error: "not_found" });
      return;
    }
    if (req.method !== "POST") {
      json(res, 405, { error: "method_not_allowed" });
      return;
    }
    route(req, clientIp(req)).then(
      (result) => json(res, 200, result),
      (error: unknown) => {
        if (error instanceof HttpError) {
          if (!res.headersSent) json(res, error.status, { error: error.code });
          if (error.status === 413) req.destroy();
          return;
        }
        log("internal_error");
        if (!res.headersSent) json(res, 500, { error: "internal_error" });
      },
    );
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;

  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, options.host, () => {
          server.off("error", reject);
          const address = server.address();
          resolve(
            address && typeof address === "object"
              ? { host: address.address, port: address.port }
              : { host: options.host, port: options.port },
          );
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

async function main(): Promise<void> {
  const options = resolvePushServiceOptionsFromEnv();
  const service = createPushService(options);
  const address = await service.listen();
  options.log("listening", { host: address.host, port: address.port });

  const shutdown = (signal: string): void => {
    options.log("shutdown", { signal });
    void service.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `push service failed to start: ${error instanceof Error ? error.message : "unknown"}\n`,
    );
    process.exit(1);
  });
}
