import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  UsageAgentTreeChat,
  UsageGetBreakdownResponseMessage,
  UsageGetSummaryResponseMessage,
  UsageGroupBy,
  UsageRange,
} from "@pimi/protocol/messages";
import { useFetchQueries, useFetchQuery } from "@/data/query";
import { getHostRuntimeStore, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { timezoneOffsetMinutes } from "./format";

export type UsageSummary = NonNullable<UsageGetSummaryResponseMessage["payload"]["summary"]>;
export type UsageBreakdown = NonNullable<UsageGetBreakdownResponseMessage["payload"]["breakdown"]>;

// History is read from the daemon's own ledger, so a refetch is cheap; the daemon also starts an
// incremental transcript scan when a read finds the last one stale.
const HISTORY_STALE_MS = 15_000;
const HISTORY_REFETCH_MS = 60_000;

function historyKey(serverId: string) {
  return ["usage-history", serverId] as const;
}

function requireClient(serverId: string) {
  const client = getHostRuntimeStore().getClient(serverId);
  if (!client) throw new Error("Host is not connected");
  return client;
}

function unwrap<T>(error: string | null, value: T | null): T {
  if (error !== null || value === null) throw new Error(error ?? "Usage history is unavailable");
  return value;
}

export function useUsageSummaryQuery(serverId: string | null) {
  const connected = useHostRuntimeIsConnected(serverId ?? "");
  return useFetchQuery({
    queryKey: [...historyKey(serverId ?? ""), "summary"],
    queryFn: async (): Promise<UsageSummary> => {
      const { error, summary } = await requireClient(serverId ?? "").getUsageSummary({
        timezoneOffsetMinutes: timezoneOffsetMinutes(),
      });
      return unwrap(error, summary);
    },
    enabled: serverId !== null && connected,
    dataShape: "value",
    staleTimeMs: HISTORY_STALE_MS,
    refetchInterval: HISTORY_REFETCH_MS,
    retry: false,
  });
}

export interface UsageBreakdownInput {
  serverId: string | null;
  range: UsageRange;
  groupBy: UsageGroupBy;
  provider: string | null;
}

export function usageBreakdownQueryOptions(input: UsageBreakdownInput) {
  const { serverId, range, groupBy, provider } = input;
  return {
    queryKey: [...historyKey(serverId ?? ""), "breakdown", range, groupBy, provider],
    queryFn: async (): Promise<UsageBreakdown> => {
      const { error, breakdown } = await requireClient(serverId ?? "").getUsageBreakdown({
        range,
        groupBy,
        provider,
        timezoneOffsetMinutes: timezoneOffsetMinutes(),
      });
      return unwrap(error, breakdown);
    },
    dataShape: "value" as const,
    staleTimeMs: HISTORY_STALE_MS,
    retry: false,
  };
}

export function useUsageBreakdownQuery(input: UsageBreakdownInput) {
  const connected = useHostRuntimeIsConnected(input.serverId ?? "");
  return useFetchQuery({
    ...usageBreakdownQueryOptions(input),
    enabled: input.serverId !== null && connected,
  });
}

/** One breakdown per input, in order; for charts that draw one series per provider. */
export function useUsageBreakdownQueries(inputs: readonly UsageBreakdownInput[]) {
  return useFetchQueries(inputs.map((input) => usageBreakdownQueryOptions(input)));
}

export function useUsageAgentTreeQuery(input: {
  serverId: string | null;
  range: UsageRange;
  provider: string | null;
}) {
  const { serverId, range, provider } = input;
  const connected = useHostRuntimeIsConnected(serverId ?? "");
  return useFetchQuery({
    queryKey: [...historyKey(serverId ?? ""), "tree", range, provider],
    queryFn: async (): Promise<UsageAgentTreeChat[]> => {
      const { error, chats } = await requireClient(serverId ?? "").getUsageAgentTree({
        range,
        provider,
        timezoneOffsetMinutes: timezoneOffsetMinutes(),
      });
      if (error !== null) throw new Error(error);
      return chats;
    },
    enabled: serverId !== null && connected,
    dataShape: "list",
    staleTimeMs: HISTORY_STALE_MS,
    retry: false,
  });
}

/**
 * Scans provider transcripts now and refetches every history query when it finishes. The first
 * scan on a host is the backfill, so it can take seconds on a large history.
 */
export function useUsageRescan(serverId: string | null): { rescan: () => void; scanning: boolean } {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => requireClient(serverId ?? "").rescanUsage(),
    onSettled: () => queryClient.invalidateQueries({ queryKey: historyKey(serverId ?? "") }),
  });
  const { mutate } = mutation;
  const rescan = useCallback(() => {
    if (serverId !== null) mutate();
  }, [mutate, serverId]);
  return { rescan, scanning: mutation.isPending };
}
