import { useCallback, useId, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { useShallow } from "zustand/shallow";
import { selectAgentTurnPresentation, useSessionStore } from "@/stores/session-store";
import type { TurnPresentation } from "@/timeline/turn-liveness";
import type { StreamItem } from "@/types/stream";

const EMPTY_STREAM: StreamItem[] = [];

export interface AgentTileStream {
  sourceId: string;
  items: StreamItem[];
  ready: boolean;
  turnPresentation: TurnPresentation;
  timelineStatus: string;
  anchor: { reason: "initial-entry"; agentId: string; requestKey: string };
}

/**
 * The read-only transcript feed behind a grid tile. The viewed timeline owner prepares the replica
 * while `visible` is true and releases the stream demand when the tile leaves.
 */
export function useAgentTileStream(
  serverId: string,
  agentId: string,
  visible = true,
): AgentTileStream {
  const sourceId = useId();
  const { sync, items, ready } = useSessionStore(
    useShallow((state) => {
      const session = state.sessions[serverId];
      return {
        sync: session?.viewedTimelineSync,
        items: session?.agentStreamTail.get(agentId) ?? EMPTY_STREAM,
        ready: session?.agentAuthoritativeHistoryApplied.get(agentId) === true,
      };
    }),
  );
  const turnPresentation = useSessionStore(
    useShallow((state) => selectAgentTurnPresentation(state.sessions[serverId], agentId)),
  );
  useLayoutEffect(() => {
    if (!visible) return;
    sync?.replaceVisibleAgentIds(sourceId, [agentId]);
    return () => sync?.replaceVisibleAgentIds(sourceId, []);
  }, [agentId, sourceId, sync, visible]);
  const subscribe = useCallback(
    (listener: () => void) => sync?.subscribe(listener) ?? (() => {}),
    [sync],
  );
  const readStatus = useCallback(
    () => sync?.getAgentTimelineStatus(agentId) ?? "pending",
    [agentId, sync],
  );
  const timelineStatus = useSyncExternalStore(subscribe, readStatus, readStatus);
  const anchor = useMemo(
    () => ({ reason: "initial-entry" as const, agentId, requestKey: sourceId }),
    [agentId, sourceId],
  );
  return { sourceId, items, ready, turnPresentation, timelineStatus, anchor };
}
