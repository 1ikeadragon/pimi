import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelRemoteSshSetup,
  listenToRemoteSshProgress,
  prepareRemoteSsh,
  type RemoteSshProgress,
  type RemoteSshSetupResult,
  type RemoteSshSetupTarget,
  type RemoteSshStep,
} from "@/desktop/daemon/desktop-daemon";

export const REMOTE_SSH_STEPS: readonly RemoteSshStep[] = [
  "connecting",
  "checking",
  "installing",
  "starting",
  "connected",
];

export interface RemoteSshSetupState {
  /** Steps the setup has reached, in order. Null while idle. */
  visited: readonly RemoteSshStep[] | null;
  current: RemoteSshStep | null;
  message: string;
  fraction: number | null;
  version: string | null;
}

const IDLE: RemoteSshSetupState = {
  visited: null,
  current: null,
  message: "",
  fraction: null,
  version: null,
};

function versionFromMessage(message: string): string | null {
  return /Pimi (\d+\.\d+\.\d+\S*)/u.exec(message)?.[1] ?? null;
}

/**
 * Runs the desktop's remote setup (probe, install or upgrade, start) and reports its steps.
 * `run` resolves to the setup result; the failure advice is in `result.message`.
 */
export function useRemoteSshSetup() {
  const [state, setState] = useState<RemoteSshSetupState>(IDLE);
  const requestIdRef = useRef<string | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    const subscribe = async () => {
      const stop = await listenToRemoteSshProgress((progress: RemoteSshProgress) => {
        if (progress.requestId !== requestIdRef.current) return;
        setState((previous) => ({
          visited: previous.visited?.includes(progress.step)
            ? previous.visited
            : [...(previous.visited ?? []), progress.step],
          current: progress.step,
          message: progress.message,
          fraction: progress.fraction ?? null,
          version: versionFromMessage(progress.message) ?? previous.version,
        }));
      });
      if (cancelled) stop();
      else unlisten = stop;
    };
    void subscribe();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const run = useCallback(async (target: RemoteSshSetupTarget): Promise<RemoteSshSetupResult> => {
    const requestId = `ssh-${globalThis.crypto.randomUUID()}`;
    requestIdRef.current = requestId;
    setState({ ...IDLE, visited: [], current: "connecting", message: "Connecting" });
    try {
      return await prepareRemoteSsh({ requestId, target });
    } finally {
      requestIdRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    const requestId = requestIdRef.current;
    if (requestId) void cancelRemoteSshSetup(requestId);
  }, []);

  const reset = useCallback(() => setState(IDLE), []);

  return { state, run, cancel, reset };
}
