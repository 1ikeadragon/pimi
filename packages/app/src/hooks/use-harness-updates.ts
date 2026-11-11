import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { fetchQueryOptions, useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

const CHECK_INTERVAL_MS = 30 * 60_000;

export function useHarnessUpdates(serverId: string) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const queryClient = useQueryClient();
  const queryKey = ["provider-harness-updates", serverId] as const;
  const enabled = connected && Boolean(client);
  const query = useFetchQuery({
    dataShape: "value",
    queryKey,
    queryFn: () => client!.checkProviderHarnessUpdates(),
    enabled,
    staleTimeMs: CHECK_INTERVAL_MS,
    refetchInterval: CHECK_INTERVAL_MS,
    retry: false,
  });
  const checkNow = useCallback(async () => {
    if (!enabled || !client) return;
    await queryClient.fetchQuery(
      fetchQueryOptions({
        dataShape: "value",
        queryKey: ["provider-harness-updates", serverId],
        queryFn: () => client.checkProviderHarnessUpdates({ force: true }),
        staleTimeMs: 0,
        retry: false,
      }),
    );
  }, [client, enabled, queryClient, serverId]);
  return { ...query, enabled, checkNow };
}
