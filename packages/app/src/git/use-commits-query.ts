import type { CheckoutCommit } from "@pimi/protocol/messages";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useFetchQuery } from "@/data/query";
import { checkoutCommitsQueryKey } from "@/git/query-keys";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

// Commits ahead of base change rarely while the section is open; this keeps a
// collapse/re-expand cycle warm without leaving the fetch result stale for long.
const CHECKOUT_COMMITS_STALE_TIME = 30_000;

interface UseCheckoutCommitsQueryOptions {
  serverId: string;
  cwd: string;
  enabled?: boolean;
}

export interface CheckoutCommitsData {
  baseRef: string | null;
  commits: CheckoutCommit[];
}

export type CheckoutCommitsQueryResult =
  | { status: "idle" }
  | { status: "connecting" }
  | { status: "loading" }
  | { status: "error"; error: Error }
  | { status: "loaded"; data: CheckoutCommitsData };

interface ResolveCheckoutCommitsQueryResultInput {
  enabled: boolean;
  canFetch: boolean;
  data: CheckoutCommitsData | undefined;
  isPlaceholderData: boolean;
  error: Error | null;
}

export function resolveCheckoutCommitsQueryResult({
  enabled,
  canFetch,
  data,
  isPlaceholderData,
  error,
}: ResolveCheckoutCommitsQueryResultInput): CheckoutCommitsQueryResult {
  if (data && !isPlaceholderData) {
    return { status: "loaded", data };
  }
  if (!enabled) {
    return { status: "idle" };
  }
  if (!canFetch) {
    return { status: "connecting" };
  }
  if (error) {
    return { status: "error", error };
  }
  return { status: "loading" };
}

export function useCheckoutCommitsQuery({
  serverId,
  cwd,
  enabled = true,
}: UseCheckoutCommitsQueryOptions): CheckoutCommitsQueryResult {
  const retainedPanelActive = useRetainedPanelActive();
  const queryEnabledByCaller = enabled && retainedPanelActive;
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);

  const canFetch = Boolean(cwd) && Boolean(client) && isConnected;
  const queryEnabled = queryEnabledByCaller && canFetch;

  const query = useFetchQuery<CheckoutCommitsData>({
    queryKey: checkoutCommitsQueryKey(serverId, cwd),
    queryFn: async () => {
      if (!client) {
        throw new Error("Host disconnected");
      }
      const data = await client.listCheckoutCommits(cwd);
      return { baseRef: data.baseRef, commits: data.commits };
    },
    enabled: queryEnabled,
    staleTimeMs: CHECKOUT_COMMITS_STALE_TIME,
    dataShape: "list",
  });

  return resolveCheckoutCommitsQueryResult({
    enabled: queryEnabledByCaller,
    canFetch,
    data: query.data,
    isPlaceholderData: query.isPlaceholderData,
    error: query.error,
  });
}
