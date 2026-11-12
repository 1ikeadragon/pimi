import { useEffect, useMemo } from "react";
import { create } from "zustand";
import type { AttackRun, Finding } from "@pimi/protocol/attack/types";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

interface HostAttackState {
  runs: Record<string, AttackRun>;
  findings: Record<string, Record<string, Finding>>;
}

interface AttackStore {
  byServer: Record<string, HostAttackState>;
  putRun: (serverId: string, run: AttackRun) => void;
  putRuns: (serverId: string, runs: AttackRun[]) => void;
  putFinding: (serverId: string, finding: Finding) => void;
  putFindings: (serverId: string, runId: string, findings: Finding[]) => void;
}

const EMPTY_HOST: HostAttackState = { runs: {}, findings: {} };

function hostOf(state: AttackStore, serverId: string): HostAttackState {
  return state.byServer[serverId] ?? EMPTY_HOST;
}

// Runs and findings live on the daemon; this mirrors them for the panels and keeps them fresh
// from `attack.run.changed` and `attack.finding.changed` pushes.
export const useAttackStore = create<AttackStore>((set) => ({
  byServer: {},
  putRun: (serverId, run) =>
    set((state) => {
      const host = hostOf(state, serverId);
      return {
        byServer: {
          ...state.byServer,
          [serverId]: { ...host, runs: { ...host.runs, [run.id]: run } },
        },
      };
    }),
  putRuns: (serverId, runs) =>
    set((state) => {
      const host = hostOf(state, serverId);
      const next = { ...host.runs };
      for (const run of runs) next[run.id] = run;
      return { byServer: { ...state.byServer, [serverId]: { ...host, runs: next } } };
    }),
  putFinding: (serverId, finding) =>
    set((state) => {
      const host = hostOf(state, serverId);
      const forRun = host.findings[finding.runId] ?? {};
      // A push carries no screenshot bytes; keep the ones a detail fetch already brought.
      const previous = forRun[finding.id];
      const merged = previous && previous.updatedAt === finding.updatedAt ? previous : finding;
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
      const next: Record<string, Finding> = {};
      for (const finding of findings) next[finding.id] = finding;
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
  return useMemo(() => (byId ? Object.values(byId) : []), [byId]);
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
    const offRun = client.on("attack.run.changed", (message) => {
      putRun(serverId, message.payload.run);
    });
    const offFinding = client.on("attack.finding.changed", (message) => {
      putFinding(serverId, message.payload.finding);
    });
    let cancelled = false;
    // Pushes are the fast path; this refresh keeps the meters and status right if one is missed.
    const refresh = async () => {
      const { runs } = await client.attackRunList({ workspaceId });
      if (!cancelled) putRuns(serverId, runs);
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
      offRun();
      offFinding();
    };
  }, [client, connected, serverId, workspaceId]);
}
