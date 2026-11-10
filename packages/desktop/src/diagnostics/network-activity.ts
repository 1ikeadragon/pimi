import type { Session } from "electron";
import {
  NetworkActivityRecorder,
  type NetworkActivitySnapshotOptions,
} from "@pimi/protocol/network-activity";
import type { NetworkActivityRequest, NetworkActivitySnapshot } from "@pimi/protocol/messages";
import { installNodeNetworkMonitor } from "@pimi/server/network-activity";

// The desktop app's outbound requests: the main process's own Node traffic (update checks,
// daemon health probes) through diagnostics channels, and every Chromium session the app
// creates through webRequest. Same record shape and privacy rules as the daemon's recorder.

const recorder = new NetworkActivityRecorder({ idPrefix: "a", capacity: 1000 });
let nodeMonitorInstalled = false;

/** Call once, as early as possible in main, so update checks at startup are recorded. */
export function installDesktopNodeNetworkMonitor(): void {
  if (nodeMonitorInstalled) return;
  nodeMonitorInstalled = true;
  installNodeNetworkMonitor({ recorder, source: "app" });
}

export function getDesktopNetworkActivity(
  options: NetworkActivitySnapshotOptions,
): NetworkActivitySnapshot {
  return recorder.snapshot(options);
}

const NETWORK_FILTER = { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] };
// A request that never completes (an open WebSocket, a cancelled page) must not grow the map.
const MAX_PENDING = 2000;

export interface ObserveSessionNetworkOptions {
  /** "app" for app surfaces, "browser" for the in-app browser profile. */
  source: string;
  /** Call-site attribution for non-local requests in this session. */
  purpose?: string;
  /**
   * Electron keeps one listener per webRequest event per session. A session that needs its
   * own onErrorOccurred passes it here; it runs for every error this observer sees.
   */
  onErrorOccurred?: (details: Electron.OnErrorOccurredListenerDetails) => void;
}

interface SessionObservation {
  pending: Map<number, NetworkActivityRequest>;
}

const observations = new WeakMap<Session, SessionObservation>();

function startRecord(
  url: string,
  method: string,
  options: ObserveSessionNetworkOptions,
): NetworkActivityRequest | null {
  const parsed = URL.parse(url);
  if (!parsed) return null;
  return recorder.start({
    source: options.source,
    method,
    protocol: parsed.protocol.replace(/:$/, ""),
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : null,
    path: parsed.pathname,
    purpose: options.purpose ?? null,
  });
}

/**
 * Records every HTTP(S) and WebSocket request in `target`. Uses only the non-blocking
 * onSendHeaders, onBeforeRedirect, onCompleted, and onErrorOccurred events, so it never delays
 * or alters a request. Calling it again for the same session replaces the listeners and keeps
 * the pending-request state.
 */
export function observeSessionNetwork(
  target: Session,
  options: ObserveSessionNetworkOptions,
): void {
  let observation = observations.get(target);
  if (!observation) {
    observation = { pending: new Map() };
    observations.set(target, observation);
  }
  const { pending } = observation;
  const take = (id: number): NetworkActivityRequest | undefined => {
    const record = pending.get(id);
    pending.delete(id);
    return record;
  };

  target.webRequest.onSendHeaders(NETWORK_FILTER, (details) => {
    const record = startRecord(details.url, details.method, options);
    if (!record) return;
    pending.set(details.id, record);
    if (pending.size > MAX_PENDING) {
      const oldest = pending.keys().next().value;
      if (oldest !== undefined) pending.delete(oldest);
    }
  });
  target.webRequest.onBeforeRedirect(NETWORK_FILTER, (details) => {
    // The next hop arrives as a new onSendHeaders with the same id.
    const record = take(details.id);
    if (record) recorder.finish(record, { status: details.statusCode });
  });
  target.webRequest.onCompleted(NETWORK_FILTER, (details) => {
    const record = take(details.id) ?? startRecord(details.url, details.method, options);
    if (record) recorder.finish(record, { status: details.statusCode });
  });
  target.webRequest.onErrorOccurred(NETWORK_FILTER, (details) => {
    const errorCode = details.error.replace(/^net::/, "");
    // Chromium reports ERR_CACHE_MISS for duplicate preload requests. They are not failures.
    if (errorCode === "ERR_CACHE_MISS") {
      const pendingRecord = take(details.id);
      if (pendingRecord) recorder.discard(pendingRecord);
      options.onErrorOccurred?.(details);
      return;
    }
    // Requests cancelled before headers were sent (blocked by a session policy) have no record yet.
    const record = take(details.id) ?? startRecord(details.url, details.method, options);
    if (record) recorder.finish(record, { errorCode });
    options.onErrorOccurred?.(details);
  });
}
