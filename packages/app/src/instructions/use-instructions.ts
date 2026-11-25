import type { InstructionsResult, InstructionsTarget } from "@pimi/protocol/messages";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { instructionsQueryKey } from "./model";

/**
 * The layers reach the agent at launch, so the answer is only as fresh as the files on disk:
 * always refetch when a view mounts (`staleTimeMs: 0`) instead of serving a cached result.
 */
export function useInstructions(serverId: string, target: InstructionsTarget | null) {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  return useFetchQuery<InstructionsResult>({
    queryKey: instructionsQueryKey(serverId, target),
    dataShape: "value",
    staleTimeMs: 0,
    enabled: client !== null && isConnected && target !== null,
    gcTime: 0,
    retry: false,
    queryFn: async () => {
      if (client === null || target === null) {
        throw new Error("Instructions requested without a connected host or target");
      }
      const payload = await client.listProviderInstructions(target);
      if (payload.error !== null || payload.result === null) {
        throw new Error(payload.error ?? "The host returned no instruction layers");
      }
      return payload.result;
    },
  });
}
