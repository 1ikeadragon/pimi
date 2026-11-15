import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import type { DaemonClient } from "@pimi/client/internal/daemon-client";
import { isDev } from "@/constants/platform";
import { ensureOsNotificationPermission } from "@/utils/os-notifications";

// Android push (FCM) registration. One handle per paired host: the push service binds it to that
// host's serverId, so a handle can never notify about another host. Every failure leaves push off;
// the local notification path keeps working on its own.

// The push origin is fixed at build time. A paired daemon can advertise any URL, so the phone only
// ever sends its FCM token to this one and skips push when the daemon names a different service.
// Self-hosted builds set EXPO_PUBLIC_PIMI_PUSH_ENDPOINT to their own https://<relay>/push.
// Empty when the build-time value is not a URL, which turns push off.
const PINNED_PUSH_ENDPOINT =
  normalizeEndpoint(
    process.env.EXPO_PUBLIC_PIMI_PUSH_ENDPOINT ?? "https://relay.stateless.computer/push",
  ) ?? "";

function normalizeEndpoint(value: string): string | null {
  try {
    return new URL(value).href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

const STORAGE_KEY = "@pimi:push-handles";
const REQUEST_TIMEOUT_MS = 5_000;
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

interface StoredHandle {
  handle: string;
  endpoint: string;
  registeredAt: number;
}

type StoredHandles = Record<string, StoredHandle>;

const inFlight = new Map<string, Promise<void>>();

async function readStored(): Promise<StoredHandles> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return typeof parsed === "object" && parsed !== null ? (parsed as StoredHandles) : {};
  } catch {
    return {};
  }
}

async function writeStored(handles: StoredHandles): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(handles));
}

// Cleartext is a dev-only escape hatch for a push service on the local machine.
function isAcceptableEndpoint(endpoint: string): boolean {
  if (endpoint.startsWith("https://")) return true;
  return isDev && endpoint.startsWith("http://");
}

async function postJson(
  endpoint: string,
  route: string,
  body: Record<string, string>,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const response = await fetch(`${endpoint}/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: response.status, json };
}

async function readDeviceToken(): Promise<string | null> {
  const Notifications = await import("expo-notifications");
  const token = await Notifications.getDevicePushTokenAsync();
  return token.type === "android" && typeof token.data === "string" ? token.data : null;
}

// `gone` means the service no longer knows the handle we presented (expired or pruned). Any other
// failure leaves the stored handle usable, so the caller keeps it.
async function registerWithService(input: {
  endpoint: string;
  serverId: string;
  token: string;
  existingHandle: string | null;
}): Promise<{ handle: string | null; gone: boolean }> {
  const attempt = async (handle: string | null) =>
    await postJson(input.endpoint, "register", {
      token: input.token,
      serverId: input.serverId,
      ...(handle ? { handle } : {}),
    });
  let result = await attempt(input.existingHandle);
  const gone = result.status === 410 && input.existingHandle !== null;
  if (gone) result = await attempt(null);
  const handle = result.json?.handle;
  return { handle: result.status === 200 && typeof handle === "string" ? handle : null, gone };
}

async function runSync(input: { client: DaemonClient; serverId: string }): Promise<void> {
  if (!(await ensureOsNotificationPermission())) return;
  const stored = (await readStored())[input.serverId];
  const sameEndpoint = stored?.endpoint === PINNED_PUSH_ENDPOINT;
  let handle = sameEndpoint ? stored.handle : null;
  const fresh = sameEndpoint && Date.now() - stored.registeredAt < RENEW_AFTER_MS;
  if (!handle || !fresh) {
    // A failed renewal keeps the stored handle: it still works until the service says otherwise.
    const renewed = await renewHandle(input.serverId, handle);
    if (renewed.handle) {
      handle = renewed.handle;
      await writeStored({
        ...(await readStored()),
        [input.serverId]: {
          handle,
          endpoint: PINNED_PUSH_ENDPOINT,
          registeredAt: Date.now(),
        },
      });
    } else if (renewed.gone) {
      handle = null;
    }
  }
  if (!handle) return;
  // The daemon ties the handle to this connection, so it is sent on every connect.
  await input.client.registerPushHandle(handle);
}

async function renewHandle(
  serverId: string,
  existingHandle: string | null,
): Promise<{ handle: string | null; gone: boolean }> {
  try {
    const token = await readDeviceToken();
    if (!token) return { handle: null, gone: false };
    return await registerWithService({
      endpoint: PINNED_PUSH_ENDPOINT,
      serverId,
      token,
      existingHandle,
    });
  } catch (error) {
    console.warn("[Push] Renewal failed", error instanceof Error ? error.message : "");
    return { handle: null, gone: false };
  }
}

/** Registers this device for push from one host. Android only; safe to call on every connect. */
export function syncPushRegistration(input: {
  client: DaemonClient;
  serverId: string;
  pushEndpoint: string;
}): Promise<void> {
  if (
    Platform.OS !== "android" ||
    !PINNED_PUSH_ENDPOINT ||
    normalizeEndpoint(input.pushEndpoint) !== PINNED_PUSH_ENDPOINT ||
    !isAcceptableEndpoint(PINNED_PUSH_ENDPOINT)
  ) {
    return Promise.resolve();
  }
  const pending =
    inFlight.get(input.serverId) ??
    runSync(input)
      .catch((error: unknown) => {
        console.warn("[Push] Registration skipped", error instanceof Error ? error.message : "");
      })
      .finally(() => inFlight.delete(input.serverId));
  inFlight.set(input.serverId, pending);
  return pending;
}

/** Revokes the handle for a host that was unpaired. Best effort; the service expires it anyway. */
export async function unregisterPush(serverId: string, client: DaemonClient | null): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    const stored = await readStored();
    const entry = stored[serverId];
    if (!entry) return;
    const { [serverId]: _removed, ...rest } = stored;
    await writeStored(rest);
    // Daemon first: it stops sending, then the service drops the token.
    await client?.unregisterPushHandle(entry.handle).catch(() => undefined);
    if (entry.endpoint === PINNED_PUSH_ENDPOINT) {
      await postJson(entry.endpoint, "unregister", { handle: entry.handle }).catch(() => null);
    }
  } catch (error) {
    console.warn("[Push] Unregister failed", error instanceof Error ? error.message : "");
  }
}
