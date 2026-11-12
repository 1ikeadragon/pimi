import { useEffect, useSyncExternalStore } from "react";
import { getDesktopHost } from "@/desktop/host";

// Stills of agent browser tabs for the attack grid. Never a second live webview: one capture runs
// at a time, working tiles refresh round-robin, and everything pauses while the window is hidden
// or unfocused, or when no tile wants a still.
const THUMBNAIL_WIDTH = 480;
const REFRESH_MS = 2000;
const TICK_MS = 500;
const MAX_REFRESHING = 4;

interface Wanted {
  workspaceId: string;
  live: boolean;
  count: number;
}

const wanted = new Map<string, Wanted>();
const stills = new Map<string, string>();
const lastCaptureAt = new Map<string, number>();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

function notify() {
  for (const listener of listeners) listener();
}

function windowActive(): boolean {
  return typeof document !== "undefined" && !document.hidden && document.hasFocus();
}

async function capture(browserId: string, workspaceId: string) {
  const execute = getDesktopHost()?.browser?.executeAutomationCommand;
  if (!execute) return;
  const payload = await execute({
    type: "browser.automation.execute.request",
    requestId: `thumb:${browserId}:${Date.now()}`,
    workspaceId,
    command: {
      command: "screenshot",
      args: { browserId, fullPage: false, thumbnailWidth: THUMBNAIL_WIDTH },
    },
  });
  if (payload.ok && payload.result.command === "screenshot") {
    stills.set(browserId, `data:${payload.result.mimeType};base64,${payload.result.dataBase64}`);
    notify();
  }
}

function tick() {
  if (inFlight || !windowActive()) return;
  const now = Date.now();
  let next: [string, Wanted] | null = null;
  let oldest = Infinity;
  let refreshing = 0;
  for (const entry of wanted) {
    const [browserId, want] = entry;
    const last = lastCaptureAt.get(browserId) ?? 0;
    if (want.live) {
      if (refreshing >= MAX_REFRESHING) continue;
      refreshing += 1;
      if (now - last < REFRESH_MS) continue;
    } else if (last !== 0 && stills.has(browserId)) {
      continue;
    }
    if (last < oldest) {
      oldest = last;
      next = entry;
    }
  }
  if (!next) return;
  const [browserId, wantedStill] = next;
  inFlight = true;
  lastCaptureAt.set(browserId, now);
  capture(browserId, wantedStill.workspaceId)
    .catch(() => undefined)
    .finally(() => {
      inFlight = false;
    });
}

function requestStill(browserId: string, workspaceId: string, live: boolean): () => void {
  const existing = wanted.get(browserId);
  if (existing) {
    existing.count += 1;
    existing.live = existing.live || live;
  } else {
    wanted.set(browserId, { workspaceId, live, count: 1 });
  }
  timer ??= setInterval(tick, TICK_MS);
  return () => {
    const current = wanted.get(browserId);
    if (!current) return;
    current.count -= 1;
    if (current.count > 0) return;
    wanted.delete(browserId);
    stills.delete(browserId);
    lastCaptureAt.delete(browserId);
    if (wanted.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A data URL still of the tab, or null until the first capture lands. */
export function useBrowserThumbnail(
  browserId: string | null,
  workspaceId: string,
  live: boolean,
): string | null {
  useEffect(() => {
    if (!browserId) return;
    return requestStill(browserId, workspaceId, live);
  }, [browserId, workspaceId, live]);
  // The snapshot is the still itself, so the render reads the store through React and not a
  // module global the compiler could memoize.
  return useSyncExternalStore(
    subscribe,
    () => (browserId ? (stills.get(browserId) ?? null) : null),
    () => null,
  );
}
