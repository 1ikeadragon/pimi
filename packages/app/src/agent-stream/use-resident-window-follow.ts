import { useEffect, useRef } from "react";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { setReaderFollowingEnd } from "@/timeline/reader-follow";
import { planTimelineCatchUpAfter } from "@/timeline/timeline-sync-plan";
import { useStableEvent } from "@/hooks/use-stable-event";
import type { NearBottom } from "./near-bottom";

const newerFetchesInFlight = new Set<string>();

/**
 * Keeps the bounded resident window in step with the reader at the newer end.
 *
 * While the reader is away from the bottom, trims of the oldest turns are held back (they
 * would shift the viewport). On reaching the bottom this releases them, re-collapses the
 * mounted history, and, when the window is detached from the live tail by a deep backward
 * read, pages forward with `direction: "after"` until the tail is reached again.
 */
export function useResidentWindowFollow(input: {
  enabled: boolean;
  serverId: string;
  agentId: string;
  nearBottom: NearBottom;
  isTimelineDetached: boolean;
  collapseHistoryWindow: () => void;
  onForwardLoadError: () => void;
}): void {
  const { enabled, serverId, agentId, nearBottom, isTimelineDetached } = input;
  const collapseHistoryWindow = useStableEvent(input.collapseHistoryWindow);
  const onForwardLoadError = useStableEvent(input.onForwardLoadError);
  const wasNearBottom = useRef(true);

  useEffect(() => {
    if (!enabled) return;
    wasNearBottom.current = nearBottom.get();
    setReaderFollowingEnd(serverId, agentId, wasNearBottom.current);
    const key = `${serverId}:${agentId}`;

    const loadNewerWhileDetached = () => {
      const session = useSessionStore.getState().sessions[serverId];
      const range = session?.agentTimelineCursor.get(agentId);
      if (!session || !range || session.agentTimelineHasNewer.get(agentId) !== true) return;
      if (newerFetchesInFlight.has(key)) return;
      newerFetchesInFlight.add(key);
      getHostRuntimeStore()
        .fetchAgentTimeline(
          serverId,
          agentId,
          planTimelineCatchUpAfter({ epoch: range.epoch, seq: range.endSeq }),
        )
        .then(
          () => {
            newerFetchesInFlight.delete(key);
            // A page that leaves the reader at the bottom and still detached continues.
            if (nearBottom.get()) loadNewerWhileDetached();
            return undefined;
          },
          () => {
            newerFetchesInFlight.delete(key);
            onForwardLoadError();
          },
        );
    };

    const settle = () => {
      const following = nearBottom.get();
      setReaderFollowingEnd(serverId, agentId, following);
      const returned = following && !wasNearBottom.current;
      wasNearBottom.current = following;
      if (!following) return;
      useSessionStore.getState().trimAgentResidentWindow(serverId, agentId, "oldest");
      if (returned) collapseHistoryWindow();
      loadNewerWhileDetached();
    };

    const unsubscribe = nearBottom.subscribe(settle);
    // A detach that happens while the reader already sits at the bottom has no scroll to react to.
    if (isTimelineDetached && wasNearBottom.current) loadNewerWhileDetached();
    return () => {
      unsubscribe();
      setReaderFollowingEnd(serverId, agentId, true);
    };
  }, [
    agentId,
    collapseHistoryWindow,
    enabled,
    isTimelineDetached,
    nearBottom,
    onForwardLoadError,
    serverId,
  ]);
}
