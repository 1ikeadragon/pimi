import { useCallback, useEffect, useState } from "react";
import type { AttackDesktopTarget } from "@pimi/protocol/attack/types";
import {
  getDesktopHost,
  type DesktopTargetPermissions,
  type DesktopTargetWindow,
} from "@/desktop/host";

const PERMISSION_POLL_MS = 2000;
const STILL_INTERVAL_MS = 1000;

function windowActive(): boolean {
  return typeof document !== "undefined" && !document.hidden && document.hasFocus();
}

/** True when this app can name and drive desktop windows (the macOS desktop app). */
export function hasDesktopTargetBridge(): boolean {
  return typeof getDesktopHost()?.desktopTarget?.execute === "function";
}

export interface DesktopPermissionState {
  permissions: DesktopTargetPermissions | null;
  /** Asks macOS for access: shows its prompts, then reads the state again. */
  request: () => Promise<void>;
  openSettings: (pane: "accessibility" | "screen" | "automation") => void;
}

/** The app's Accessibility and Screen Recording state, polled while the caller is mounted. */
export function useDesktopPermissions(): DesktopPermissionState {
  const [permissions, setPermissions] = useState<DesktopTargetPermissions | null>(null);
  const read = useCallback(async (prompt: boolean) => {
    const bridge = getDesktopHost()?.desktopTarget;
    if (!bridge) return;
    try {
      setPermissions(await bridge.permissions(prompt ? { prompt: true } : undefined));
    } catch {
      setPermissions(null);
    }
  }, []);
  useEffect(() => {
    void read(false);
    const timer = setInterval(() => {
      if (windowActive()) void read(false);
    }, PERMISSION_POLL_MS);
    return () => clearInterval(timer);
  }, [read]);
  const request = useCallback(() => read(true), [read]);
  const openSettings = useCallback((pane: "accessibility" | "screen" | "automation") => {
    void getDesktopHost()?.desktopTarget?.openSettings(pane);
  }, []);
  return { permissions, request, openSettings };
}

export interface DesktopStill {
  uri: string;
  width: number;
  height: number;
  windowWidth: number;
  windowHeight: number;
}

/**
 * A 1 fps still of the target window while `active`: the subview is mounted, the app window is
 * focused and visible, and the run is running. One capture is in flight at a time, so a slow
 * window slows the stills down instead of queueing them.
 */
export function useDesktopStill(
  runId: string,
  target: AttackDesktopTarget,
  active: boolean,
): { still: DesktopStill | null; error: string | null } {
  const [state, setState] = useState<{ still: DesktopStill | null; error: string | null }>({
    still: null,
    error: null,
  });
  useEffect(() => {
    const bridge = getDesktopHost()?.desktopTarget;
    if (!bridge) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const loop = async () => {
      if (stopped) return;
      if (active && windowActive()) {
        try {
          const payload = await bridge.execute({
            type: "desktop.target.execute.request",
            requestId: `still:${runId}:${Date.now()}`,
            agentId: "owner",
            guard: {
              runId,
              bundleId: target.bundleId,
              windowTitle: target.windowTitle,
              allowInput: false,
            },
            command: { command: "screenshot", args: { maxWidth: 1280 } },
          });
          if (stopped) return;
          if (payload.ok && payload.result.command === "screenshot") {
            const shot = payload.result;
            setState({
              still: {
                uri: `data:${shot.mimeType};base64,${shot.dataBase64}`,
                width: shot.width,
                height: shot.height,
                windowWidth: shot.windowWidth,
                windowHeight: shot.windowHeight,
              },
              error: null,
            });
          } else if (!payload.ok) {
            setState((current) => ({ still: current.still, error: payload.error.message }));
          }
        } catch (error) {
          if (!stopped) {
            setState((current) => ({
              still: current.still,
              error: error instanceof Error ? error.message : String(error),
            }));
          }
        }
      }
      if (!stopped) timer = setTimeout(() => void loop(), STILL_INTERVAL_MS);
    };
    void loop();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, runId, target.bundleId, target.windowTitle]);
  return state;
}

/** The windows the owner can pick as a run's target, newest list on each call. */
export async function listDesktopWindows(): Promise<{
  windows: DesktopTargetWindow[];
  error: string | null;
}> {
  const bridge = getDesktopHost()?.desktopTarget;
  if (!bridge) return { windows: [], error: null };
  const result = await bridge.listWindows();
  if (!result.ok) {
    return {
      windows: [],
      error: typeof result.error === "string" ? result.error : result.error.message,
    };
  }
  // A window can be named only when its title is unique within its app, and a window without a
  // title cannot be named at all.
  const counts = new Map<string, number>();
  for (const window of result.windows) {
    const key = `${window.bundleId}\u0000${window.windowTitle}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return {
    windows: result.windows.filter(
      (window) =>
        window.windowTitle !== "" &&
        counts.get(`${window.bundleId}\u0000${window.windowTitle}`) === 1,
    ),
    error: null,
  };
}
