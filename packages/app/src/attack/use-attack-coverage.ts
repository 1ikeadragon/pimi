import { useEffect, useState } from "react";
import type { AttackCoverage } from "@pimi/protocol/attack/types";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

const EMPTY: AttackCoverage = {};

/**
 * The routes a run's agents reached in a browser. Fetched when the Visualize subview mounts, then
 * kept fresh by the daemon's `attack.coverage.changed` push (at most once a second). Nothing runs
 * while the subview is not mounted.
 */
export function useAttackCoverage(serverId: string, runId: string): AttackCoverage {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const [state, setState] = useState<{ runId: string; coverage: AttackCoverage } | null>(null);
  useEffect(() => {
    if (!client || !connected) return;
    let cancelled = false;
    const feed = client.observeEvents(["attack.coverage.changed"]);
    const off = feed.subscribe({
      snapshot: () => {},
      update: (message) => {
        if (message.type === "attack.coverage.changed" && message.payload.runId === runId) {
          setState({ runId, coverage: message.payload.coverage });
        }
      },
    });
    client
      .attackCoverageGet({ runId })
      .then((payload) => {
        if (!cancelled) setState((current) => current ?? { runId, coverage: payload.coverage });
        return payload;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      off();
      void feed.release().catch(() => undefined);
    };
  }, [client, connected, runId]);
  return state && state.runId === runId ? state.coverage : EMPTY;
}
