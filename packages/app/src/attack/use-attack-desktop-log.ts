import { useEffect } from "react";
import { create } from "zustand";
import type { AttackDesktopAction, AttackRun } from "@pimi/protocol/attack/types";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

const MAX_ACTIONS = 200;
const EMPTY: AttackDesktopAction[] = [];

// The owner's action log for a run's desktop window: the daemon pushes one event per action and
// the app keeps the newest 200 per run in memory. Nothing is persisted; the audit tab holds the
// durable record.
const useDesktopLogStore = create<{ byRun: Record<string, AttackDesktopAction[]> }>(() => ({
  byRun: {},
}));

export function useAttackDesktopLog(runId: string): AttackDesktopAction[] {
  return useDesktopLogStore((state) => state.byRun[runId] ?? EMPTY);
}

/** Listens for the run's desktop actions while the board is open on a run with a desktop target. */
export function useAttackDesktopLogFeed(serverId: string, runId: string | null, enabled: boolean) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  useEffect(() => {
    if (!client || !connected || !runId || !enabled) return;
    const feed = client.observeEvents(["attack.desktop.action"]);
    const off = feed.subscribe({
      snapshot: () => {},
      update: (message) => {
        if (message.type !== "attack.desktop.action") return;
        const { action } = message.payload;
        if (action.runId !== runId) return;
        useDesktopLogStore.setState((state) => ({
          byRun: {
            ...state.byRun,
            [runId]: [...(state.byRun[runId] ?? EMPTY), action].slice(-MAX_ACTIONS),
          },
        }));
      },
    });
    return () => {
      off();
      void feed.release().catch(() => undefined);
    };
  }, [client, connected, enabled, runId]);
}

/** The board-level subscription: on while the latest run drives a desktop window. */
export function useAttackDesktopLogForRun(serverId: string, run: AttackRun | null) {
  useAttackDesktopLogFeed(serverId, run?.id ?? null, run?.desktopTarget != null);
}
