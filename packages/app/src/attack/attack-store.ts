import { useEffect, useMemo } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import type { AttackRun, Finding } from "@pimi/protocol/attack/types";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

interface HostAttackState {
  runs: Record<string, AttackRun>;
  findings: Record<string, Record<string, Finding>>;
}

export const ATTACK_SUBVIEWS = ["overview", "terminal", "browser", "desktop", "visualize"] as const;
export type AttackSubview = (typeof ATTACK_SUBVIEWS)[number];

const SubviewPersistedStateSchema = z.object({
  subviewByWorkspace: z.record(
    z.string(),
    z.object({ runId: z.string(), view: z.enum(ATTACK_SUBVIEWS) }),
  ),
});

export type AttackFocusView = "chat" | "browser";
export interface AttackFocus {
  agentId: string;
  view: AttackFocusView;
}

interface AttackStore {
  /** The board's focused agent, by workspace key. Cleared when a different run takes over. */
  focusByWorkspace: Record<string, (AttackFocus & { runId: string }) | null>;
  /** The board's body, by workspace key. Persisted; a different run resets it to overview. */
  subviewByWorkspace: Record<string, { runId: string; view: AttackSubview }>;
  setSubview: (workspaceKey: string, runId: string, view: AttackSubview) => void;
  /**
   * An older run the owner opened from History, by workspace key. `latestRunId` is the newest run
   * at that moment: a newer run starting later takes the board back.
   */
  viewedRunByWorkspace: Record<string, { runId: string; latestRunId: string } | null>;
  setViewedRun: (
    workspaceKey: string,
    viewed: { runId: string; latestRunId: string } | null,
  ) => void;
  /** Whether the board shows the run history list, by workspace key. */
  historyOpenByWorkspace: Record<string, boolean>;
  setHistoryOpen: (workspaceKey: string, open: boolean) => void;
  /** Set by "New run" so the board shows the launch form over a finished run's grid. */
  composingByWorkspace: Record<string, string | null>;
  /** The pre-flight target tab (a plain browser the owner annotates), by workspace key. */
  preflightByWorkspace: Record<string, { browserId: string; target: string } | null>;
  /** Narrow windows show findings as an overlay; whether it is open, by workspace key. */
  findingsOverlayByWorkspace: Record<string, boolean>;
  setPreflight: (
    workspaceKey: string,
    preflight: { browserId: string; target: string } | null,
  ) => void;
  setFindingsOverlay: (workspaceKey: string, open: boolean) => void;
  setFocus: (workspaceKey: string, runId: string, focus: AttackFocus | null) => void;
  setComposing: (workspaceKey: string, afterRunId: string | null) => void;
  byServer: Record<string, HostAttackState>;
  putRun: (serverId: string, run: AttackRun) => void;
  putRuns: (serverId: string, runs: AttackRun[]) => void;
  putFinding: (serverId: string, finding: Finding) => void;
  putFindings: (serverId: string, runId: string, findings: Finding[]) => void;
}

const EMPTY_HOST: HostAttackState = { runs: {}, findings: {} };

// A list response can land after a push that is newer than it; the newer copy stays.
function newer<T extends { updatedAt: string }>(previous: T | undefined, incoming: T): T {
  return previous && previous.updatedAt > incoming.updatedAt ? previous : incoming;
}

function hostOf(state: AttackStore, serverId: string): HostAttackState {
  return state.byServer[serverId] ?? EMPTY_HOST;
}

// Runs and findings live on the daemon; this mirrors them for the panels and keeps them fresh
// from `attack.run.changed` and `attack.finding.changed` pushes.
export const useAttackStore = create<AttackStore>()(
  persist(
    (set) => ({
      subviewByWorkspace: {},
      setSubview: (workspaceKey, runId, view) =>
        set((state) => ({
          subviewByWorkspace: { ...state.subviewByWorkspace, [workspaceKey]: { runId, view } },
        })),
      viewedRunByWorkspace: {},
      setViewedRun: (workspaceKey, viewed) =>
        set((state) => ({
          viewedRunByWorkspace: { ...state.viewedRunByWorkspace, [workspaceKey]: viewed },
        })),
      historyOpenByWorkspace: {},
      setHistoryOpen: (workspaceKey, open) =>
        set((state) => ({
          historyOpenByWorkspace: { ...state.historyOpenByWorkspace, [workspaceKey]: open },
        })),
      focusByWorkspace: {},
      composingByWorkspace: {},
      preflightByWorkspace: {},
      findingsOverlayByWorkspace: {},
      setPreflight: (workspaceKey, preflight) =>
        set((state) => ({
          preflightByWorkspace: { ...state.preflightByWorkspace, [workspaceKey]: preflight },
        })),
      setFindingsOverlay: (workspaceKey, open) =>
        set((state) => ({
          findingsOverlayByWorkspace: { ...state.findingsOverlayByWorkspace, [workspaceKey]: open },
        })),
      setFocus: (workspaceKey, runId, focus) =>
        set((state) => ({
          focusByWorkspace: {
            ...state.focusByWorkspace,
            [workspaceKey]: focus ? { ...focus, runId } : null,
          },
        })),
      setComposing: (workspaceKey, afterRunId) =>
        set((state) => ({
          composingByWorkspace: { ...state.composingByWorkspace, [workspaceKey]: afterRunId },
        })),
      byServer: {},
      putRun: (serverId, run) =>
        set((state) => {
          const host = hostOf(state, serverId);
          return {
            byServer: {
              ...state.byServer,
              [serverId]: {
                ...host,
                runs: { ...host.runs, [run.id]: newer(host.runs[run.id], run) },
              },
            },
          };
        }),
      putRuns: (serverId, runs) =>
        set((state) => {
          const host = hostOf(state, serverId);
          const next = { ...host.runs };
          for (const run of runs) next[run.id] = newer(next[run.id], run);
          return { byServer: { ...state.byServer, [serverId]: { ...host, runs: next } } };
        }),
      putFinding: (serverId, finding) =>
        set((state) => {
          const host = hostOf(state, serverId);
          const forRun = host.findings[finding.runId] ?? {};
          // A push carries no screenshot bytes; keep the ones a detail fetch already brought.
          const previous = forRun[finding.id];
          const merged = previous && previous.updatedAt >= finding.updatedAt ? previous : finding;
          return {
            byServer: {
              ...state.byServer,
              [serverId]: {
                ...host,
                findings: {
                  ...host.findings,
                  [finding.runId]: { ...forRun, [finding.id]: merged },
                },
              },
            },
          };
        }),
      putFindings: (serverId, runId, findings) =>
        set((state) => {
          const host = hostOf(state, serverId);
          // Findings are never deleted, so one a push brought while the list was in flight stays.
          const next: Record<string, Finding> = { ...host.findings[runId] };
          for (const finding of findings) {
            const previous = next[finding.id];
            next[finding.id] =
              previous && previous.updatedAt >= finding.updatedAt ? previous : finding;
          }
          return {
            byServer: {
              ...state.byServer,
              [serverId]: { ...host, findings: { ...host.findings, [runId]: next } },
            },
          };
        }),
    }),
    {
      name: "attack-subview",
      version: 1,
      storage: createValidatedPersistStorage(AsyncStorage, SubviewPersistedStateSchema),
      partialize: (state) => ({ subviewByWorkspace: state.subviewByWorkspace }),
    },
  ),
);

/** The newest run of the workspace, running or not. */
export function selectLatestRun(
  state: AttackStore,
  serverId: string,
  workspaceId: string,
): AttackRun | null {
  let latest: AttackRun | null = null;
  for (const run of Object.values(hostOf(state, serverId).runs)) {
    if (run.workspaceId !== workspaceId) continue;
    if (!latest || run.startedAt > latest.startedAt) latest = run;
  }
  return latest;
}

export function useLatestAttackRun(serverId: string, workspaceId: string): AttackRun | null {
  return useAttackStore((state) => selectLatestRun(state, serverId, workspaceId));
}

/** The run the panels show: the one opened from History, otherwise the newest. */
export function selectViewedRun(
  state: AttackStore,
  serverId: string,
  workspaceId: string,
): AttackRun | null {
  const latest = selectLatestRun(state, serverId, workspaceId);
  const viewed = state.viewedRunByWorkspace[`${serverId}:${workspaceId}`];
  if (latest && viewed && viewed.latestRunId === latest.id) {
    const run = hostOf(state, serverId).runs[viewed.runId];
    if (run && run.workspaceId === workspaceId) return run;
  }
  return latest;
}

export function useViewedAttackRun(serverId: string, workspaceId: string): AttackRun | null {
  return useAttackStore((state) => selectViewedRun(state, serverId, workspaceId));
}

export function useAttackFindings(serverId: string, runId: string | null): Finding[] {
  const client = useHostRuntimeClient(serverId);
  const loaded = useAttackStore((state) =>
    runId ? hostOf(state, serverId).findings[runId] !== undefined : true,
  );
  // An older run opened from History has no findings in the store until this first fetch.
  useEffect(() => {
    if (!client || !runId || loaded) return;
    let cancelled = false;
    void (async () => {
      try {
        const { findings } = await client.attackFindingList({ runId });
        if (!cancelled) useAttackStore.getState().putFindings(serverId, runId, findings);
      } catch {
        // The panel shows what pushes bring; the next mount retries.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, loaded, runId, serverId]);
  const byId = useAttackStore((state) =>
    runId ? hostOf(state, serverId).findings[runId] : undefined,
  );
  // A finding the lead merged into another one stays on the daemon but is not shown.
  return useMemo(
    () => (byId ? Object.values(byId).filter((finding) => finding.duplicateOf === null) : []),
    [byId],
  );
}

/**
 * Loads the host's runs and the latest run's findings, then follows the daemon's pushes. Mounted
 * by both panels; the store merges, so a second mount only repeats a cheap fetch.
 */
export function useAttackSync(serverId: string, workspaceId: string): void {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  useEffect(() => {
    if (!client || !connected) return;
    const { putRun, putRuns, putFinding, putFindings } = useAttackStore.getState();
    // Delivery is gated by event subscriptions: unsubscribed sockets never see these pushes.
    const feeds = client.observeEvents(["attack.run.changed", "attack.finding.changed"]);
    const offFeed = feeds.subscribe({
      snapshot: () => {},
      update: (message) => {
        if (message.type === "attack.run.changed") putRun(serverId, message.payload.run);
        else if (message.type === "attack.finding.changed") {
          putFinding(serverId, message.payload.finding);
        }
      },
    });
    let cancelled = false;
    // Pushes are the fast path; this refresh keeps the meters and status right if one is missed.
    const refresh = async () => {
      const { runs } = await client.attackRunList({ workspaceId });
      if (cancelled) return;
      putRuns(serverId, runs);
      const latest = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
      const loaded = latest
        ? useAttackStore.getState().byServer[serverId]?.findings[latest.id]
        : null;
      if (!latest || loaded) return;
      // A run started elsewhere has no loaded findings until this first fetch; pushes keep it fresh.
      const { findings } = await client.attackFindingList({ runId: latest.id });
      if (!cancelled) putFindings(serverId, latest.id, findings);
    };
    const poll = setInterval(() => void refresh().catch(() => undefined), 3000);
    void (async () => {
      try {
        const { runs } = await client.attackRunList({ workspaceId });
        if (cancelled) return;
        putRuns(serverId, runs);
        const latest = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
        if (!latest) return;
        const { findings } = await client.attackFindingList({ runId: latest.id });
        if (!cancelled) putFindings(serverId, latest.id, findings);
      } catch {
        // The panels show whatever pushes bring; the next mount retries.
      }
    })();
    return () => {
      cancelled = true;
      clearInterval(poll);
      offFeed();
      void feeds.release().catch(() => undefined);
    };
  }, [client, connected, serverId, workspaceId]);
}

/** The subview for the run on screen; any other run's choice is ignored, so a new run starts on overview. */
export function selectSubview(
  state: AttackStore,
  workspaceKey: string,
  runId: string | null,
): AttackSubview {
  const entry = state.subviewByWorkspace[workspaceKey];
  return entry && entry.runId === runId ? entry.view : "overview";
}
