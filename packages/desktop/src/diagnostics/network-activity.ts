import { app, type Session } from "electron";
import {
  NetworkActivityRecorder,
  type NetworkActivitySnapshotOptions,
} from "@pimi/protocol/network-activity";
import type { NetworkActivityRequest, NetworkActivitySnapshot } from "@pimi/protocol/messages";
import { installNodeNetworkMonitor } from "@pimi/server/network-activity";
import { setProcessLaunchObserver } from "@pimi/server/process-launch";
import { createProcessLaunchObserver } from "@pimi/server/process-launch-recorder";
import {
  NetworkLogStore,
  networkLogDirectory,
  type NetworkLogSettings,
} from "@pimi/server/network-log";
import { resolvePimiHome } from "@pimi/server/daemon-control";
import { maskPathSegments } from "@pimi/server/network-redact";
import { readFileSync } from "node:fs";
import path from "node:path";
import log from "electron-log/main";

// The desktop app's outbound requests: the main process's own Node traffic (update checks,
// daemon health probes), its sockets, DNS lookups and launched programs through the same hooks
// the daemon uses, and every Chromium session the app creates through webRequest (renderer,
// in-app browser pages, net.request). Same record shape and privacy rules as the daemon.
// Chromium's own browser-process traffic (component updates, safe browsing, DNS prefetch,
// WebRTC) does not pass through webRequest and is not visible here.

let appLog: NetworkLogStore | null = null;
const recorder = new NetworkActivityRecorder({
  idPrefix: "a",
  capacity: 1000,
  onFinish: (record) => appLog?.append(record),
});
let nodeMonitorInstalled = false;

const SETTINGS_REFRESH_MS = 5_000;
let cachedSettings: NetworkLogSettings = { enabled: true, retentionDays: 3 };
let settingsReadAt = 0;

// The daemon owns these settings in config.json. The app reads the file directly, since it
// must not create or rewrite it, and re-reads at most every few seconds.
function readLogSettings(): NetworkLogSettings {
  const now = Date.now();
  if (now - settingsReadAt < SETTINGS_REFRESH_MS) return cachedSettings;
  settingsReadAt = now;
  try {
    const raw = JSON.parse(
      readFileSync(path.join(resolvePimiHome(process.env), "config.json"), "utf8"),
    );
    const network = raw?.log?.network;
    cachedSettings = {
      enabled: network?.enabled !== false,
      retentionDays:
        Number.isInteger(network?.retentionDays) &&
        network.retentionDays >= 1 &&
        network.retentionDays <= 90
          ? network.retentionDays
          : 3,
    };
  } catch {
    // No config file yet, or it is mid-write: keep the last known settings.
  }
  return cachedSettings;
}

/** Starts saving the app's records next to the daemon's, under `<home>/logs/network`. */
export function startDesktopNetworkLog(): void {
  if (appLog) return;
  appLog = new NetworkLogStore({
    home: resolvePimiHome(process.env),
    source: "app",
    getSettings: readLogSettings,
    onError: (error, message) => log.warn(`[network-log] ${message}`, error),
  });
  appLog.start();
}

export function flushDesktopNetworkLog(): Promise<void> {
  return appLog ? appLog.flush() : Promise.resolve();
}

/** The one folder the "Open logs folder" action may open. */
export function getDesktopNetworkLogDirectory(): string {
  return networkLogDirectory(resolvePimiHome(process.env));
}

/** Call once, as early as possible in main, so update checks at startup are recorded. */
export function installDesktopNodeNetworkMonitor(): void {
  if (nodeMonitorInstalled) return;
  nodeMonitorInstalled = true;
  installNodeNetworkMonitor({ recorder, source: "app" });
  setProcessLaunchObserver(createProcessLaunchObserver(recorder, "app"));
  // Every session Electron creates is observed from the start, including ones no code names.
  // A session that needs a purpose or an error handler calls observeSessionNetwork again.
  app.on("session-created", (created) => observeSessionNetwork(created, { source: "app" }));
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
    path: maskPathSegments(parsed.pathname),
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

export interface DesktopProcessLabel {
  pid: number;
  label: string;
}

/** The app's own processes with the names Electron gives them, for the Resources tab. */
export function getDesktopProcessLabels(): { rootPid: number; processes: DesktopProcessLabel[] } {
  const processes = app.getAppMetrics().map((metric): DesktopProcessLabel => {
    let label: string;
    if (metric.type === "Browser") label = "Main";
    else if (metric.type === "Tab") label = "Renderer";
    else if (metric.type === "GPU") label = "GPU";
    else if (metric.serviceName?.toLowerCase().includes("network")) label = "Network";
    else label = metric.name ?? metric.serviceName ?? metric.type;
    return { pid: metric.pid, label };
  });
  return { rootPid: process.pid, processes };
}
