import { useMemo, useRef } from "react";
import { useStableEvent } from "@/hooks/use-stable-event";
import type { ToolCallRun } from "@/tool-calls/detail-level/grouping";
import type { ExpandedToolCallGroups, ToolCallExpansion } from "@/tool-calls/expansion";
import { summarizeLiveRun } from "./working-status";

/**
 * The run the working status line owns: stable across presentation re-runs that leave its calls
 * as they were, with its open state and toggles. A lone call opens as the call itself, which is
 * the row it lands in when it seals; a longer run opens as a group.
 */
export function useLiveRun(input: {
  run: ToolCallRun | null;
  expandedGroups: ExpandedToolCallGroups;
  expansion: ToolCallExpansion;
}) {
  const { expandedGroups, expansion } = input;
  const ref = useRef<ToolCallRun | null>(null);
  const liveRun = useMemo(() => {
    const next = input.run;
    const previous = ref.current;
    if (
      next &&
      previous &&
      next.id === previous.id &&
      next.calls.length === previous.calls.length &&
      next.calls.every((call, index) => call === previous.calls[index])
    ) {
      return previous;
    }
    ref.current = next;
    return next;
  }, [input.run]);
  const summary = useMemo(
    () => (liveRun ? summarizeLiveRun(liveRun.calls) : { stepCount: 0, failedCount: 0 }),
    [liveRun],
  );
  const runId = liveRun?.id ?? null;
  const liveExpanded = runId !== null && expandedGroups.has(runId);
  const isSingleCall = liveRun?.calls.length === 1;
  const setExpanded = useStableEvent((expanded: boolean) => {
    if (runId === null) return;
    if (isSingleCall) expansion.setCallExpanded({ callId: runId, expanded, standalone: true });
    else expansion.setGroupExpanded(runId, expanded);
  });
  const toggle = useStableEvent(() => setExpanded(!liveExpanded));
  const close = useStableEvent(() => setExpanded(false));
  return { liveRun, liveExpanded, summary, toggle, close };
}
