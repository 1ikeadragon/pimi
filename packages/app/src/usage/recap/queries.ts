import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Recap, RecapNarrative } from "@pimi/protocol/recap";
import { useFetchQuery } from "@/data/query";
import { getHostRuntimeStore, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { RecapRange } from "./period";

// Recap is read from stored timelines, so a refetch is cheap; a current period keeps moving.
const RECAP_STALE_MS = 30_000;

function recapKey(serverId: string, range: RecapRange) {
  return ["recap", serverId, range.startMs, range.endMs] as const;
}

function requireClient(serverId: string) {
  const client = getHostRuntimeStore().getClient(serverId);
  if (!client) throw new Error("Host is not connected");
  return client;
}

function periodOf(range: RecapRange) {
  // The offset at the period's start, so a period that began before a DST change buckets its
  // hours the way the user lived them at the time.
  const timezoneOffsetMinutes = -new Date(range.startMs).getTimezoneOffset();
  return { startMs: range.startMs, endMs: range.endMs, timezoneOffsetMinutes };
}

export function useRecapQuery(serverId: string, range: RecapRange) {
  const connected = useHostRuntimeIsConnected(serverId);
  return useFetchQuery({
    queryKey: recapKey(serverId, range),
    queryFn: async (): Promise<Recap> => {
      const { error, recap } = await requireClient(serverId).getRecap(periodOf(range));
      if (error !== null || recap === null) throw new Error(error ?? "Recap is unavailable");
      return recap;
    },
    enabled: connected,
    dataShape: "value",
    staleTimeMs: RECAP_STALE_MS,
    retry: false,
  });
}

/** Asks the host's Recap model to write the period's narrative and puts it into the cached recap. */
export function useWriteRecapNarrative(serverId: string, range: RecapRange) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<RecapNarrative> => {
      const { error, narrative } = await requireClient(serverId).generateRecapNarrative(
        periodOf(range),
      );
      if (error !== null || narrative === null) throw new Error(error ?? "No recap was written");
      return narrative;
    },
    onSuccess: async (narrative) => {
      // A read still in flight started before the narrative was stored and would overwrite it.
      await queryClient.cancelQueries({ queryKey: recapKey(serverId, range) });
      queryClient.setQueryData<Recap>(recapKey(serverId, range), (recap) =>
        recap ? { ...recap, narrative } : recap,
      );
    },
  });
}
