import { useMemo } from "react";
import { useFetchQuery } from "@/data/query";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";
import {
  fetchAggregatedAutomations,
  automationsQueryBaseKey,
  type AggregateLoadState,
  type AggregatedAutomation,
  type AutomationHostError,
  type AutomationHostInput,
} from "@/automations/aggregated-automations";

const NO_HOSTS: AutomationHostInput[] = [];
const NO_HOST_ERRORS: AutomationHostError[] = [];

export type {
  AggregateLoadState,
  AggregatedAutomation,
  AutomationHostError,
  AutomationHostInput,
} from "@/automations/aggregated-automations";

export function automationsQueryKey(serverIds: readonly string[]) {
  return [...automationsQueryBaseKey, [...serverIds].sort().join("|")] as const;
}

export interface UseAutomationsResult {
  loadState: AggregateLoadState<AggregatedAutomation>;
  hostErrors: AutomationHostError[];
  /** Hosts still connecting after another host answered. */
  connectingHosts: AutomationHostInput[];
  isError: boolean;
  error: Error | null;
  refetch: () => void;
  isRefetching: boolean;
}

export function useAutomations(): UseAutomationsResult {
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const hostInputs = useMemo<AutomationHostInput[]>(
    () => hosts.map((host) => ({ serverId: host.serverId, serverName: host.label })),
    [hosts],
  );
  const serverIds = useMemo(() => hostInputs.map((host) => host.serverId), [hostInputs]);
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);
  const connectionStatusKey = useMemo(
    () => serverIds.map((serverId) => connectionStatuses.get(serverId) ?? "connecting").join("|"),
    [connectionStatuses, serverIds],
  );

  const query = useFetchQuery({
    queryKey: [...automationsQueryKey(serverIds), connectionStatusKey],
    queryFn: () => fetchAggregatedAutomations({ hosts: hostInputs, runtime }),
    dataShape: "list",
    staleTimeMs: 5_000,
  });

  let loadState: AggregateLoadState<AggregatedAutomation>;
  if (query.data?.status === "connecting") {
    loadState = { status: "connecting" };
  } else if (query.data?.status === "loaded") {
    loadState = { status: "loaded", data: query.data.data };
  } else {
    loadState = { status: "loading" };
  }

  return {
    loadState,
    hostErrors: query.data?.status === "loaded" ? query.data.hostErrors : NO_HOST_ERRORS,
    connectingHosts: query.data?.status === "loaded" ? query.data.connectingHosts : NO_HOSTS,
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
    isRefetching: query.isRefetching,
  };
}
