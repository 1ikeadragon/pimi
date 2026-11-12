import { useEffect, useMemo } from "react";
import { create } from "zustand";
import type { AttackRun, Finding } from "@pimi/protocol/attack/types";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

interface HostAttackState {
  runs: Record<string, AttackRun>;
  findings: Record<string, Record<string, Finding>>;
}

export type AttackFocusView = "chat" | "browser";
export interface AttackFocus {
  agentId: string;
  view: AttackFocusView;
}

interface AttackStore {
  /** The board's focused agent, by workspace key. Cleared when a different run takes over. */
  focusByWorkspace: Record<string, (AttackFocus & { runId: string }) | null>;
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
export const useAttackStore = create<AttackStore>((set) => ({
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
          [serverId]: { ...host, runs: { ...host.runs, [run.id]: newer(host.runs[run.id], run) } },
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
            findings: { ...host.findings, [finding.runId]: { ...forRun, [finding.id]: merged } },
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
        next[finding.id] = previous && previous.updatedAt >= finding.updatedAt ? previous : finding;
      }
      return {
        byServer: {
          ...state.byServer,
          [serverId]: { ...host, findings: { ...host.findings, [runId]: next } },
        },
      };
    }),
}));

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

export function useAttackFindings(serverId: string, runId: string | null): Finding[] {
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
