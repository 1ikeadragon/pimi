import { useCallback, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@pimi/client/internal/daemon-client";
import type { Flow, FlowDefinition, FlowRun } from "@pimi/protocol/flow/types";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

export function flowsQueryKey(serverId: string) {
  return ["flows", serverId] as const;
}

export function flowRunQueryKey(serverId: string, runId: string) {
  return ["flow-run", serverId, runId] as const;
}

export function requireFlowClient(serverId: string): DaemonClient {
  const client = useSessionStore.getState().sessions[serverId]?.client ?? null;
  if (!client) throw new Error("Host is not connected");
  return client;
}

/** The host's saved flows, sorted by name. Flows belong to the host, not to a project. */
export function useFlows(serverId: string, options: { enabled?: boolean } = {}) {
  const connected = useHostRuntimeIsConnected(serverId);
  return useFetchQuery({
    queryKey: flowsQueryKey(serverId),
    enabled: Boolean(serverId) && connected && (options.enabled ?? true),
    dataShape: "list",
    staleTimeMs: 15_000,
    queryFn: async (): Promise<Flow[]> => (await requireFlowClient(serverId).flowList()).flows,
  });
}

export function useFlow(serverId: string, flowId: string | undefined) {
  const connected = useHostRuntimeIsConnected(serverId);
  return useFetchQuery({
    queryKey: ["flow", serverId, flowId],
    enabled: Boolean(serverId && flowId) && connected,
    dataShape: "value",
    staleTimeMs: 5_000,
    queryFn: async (): Promise<Flow> => {
      if (!flowId) throw new Error("Missing flow id");
      return (await requireFlowClient(serverId).flowGet({ flowId })).flow;
    },
  });
}

export interface FlowMutations {
  createFlow: (definition: FlowDefinition) => Promise<Flow>;
  updateFlow: (input: { flowId: string; definition: FlowDefinition }) => Promise<Flow>;
  deleteFlow: (flowId: string) => Promise<void>;
  approveFlow: (flowId: string) => Promise<Flow>;
  runApproveAndStart: (input: { flowId: string; runId: string }) => Promise<FlowRun>;
  cancelRun: (runId: string) => Promise<FlowRun>;
  retryRun: (runId: string) => Promise<FlowRun>;
}

/** Flow writes for one host. Every write refreshes the flow list and the flows it touched. */
export function useFlowMutations(serverId: string): FlowMutations {
  const queryClient = useQueryClient();
  const refresh = useCallback(
    () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: flowsQueryKey(serverId) }),
        queryClient.invalidateQueries({ queryKey: ["flow", serverId] }),
      ]),
    [queryClient, serverId],
  );
  const setRun = useCallback(
    (run: FlowRun) => queryClient.setQueryData(flowRunQueryKey(serverId, run.id), run),
    [queryClient, serverId],
  );
  const create = useMutation({
    mutationFn: async (definition: FlowDefinition) =>
      (await requireFlowClient(serverId).flowCreate({ definition })).flow,
    onSuccess: refresh,
  });
  const update = useMutation({
    mutationFn: async (input: { flowId: string; definition: FlowDefinition }) =>
      (await requireFlowClient(serverId).flowUpdate(input)).flow,
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: async (flowId: string) => {
      await requireFlowClient(serverId).flowDelete({ flowId });
    },
    onSuccess: refresh,
  });
  const approve = useMutation({
    mutationFn: async (flowId: string) =>
      (await requireFlowClient(serverId).flowApprove({ flowId })).flow,
    onSuccess: refresh,
  });
  const approveAndStart = useMutation({
    mutationFn: async (input: { flowId: string; runId: string }) => {
      const client = requireFlowClient(serverId);
      await client.flowApprove({ flowId: input.flowId });
      return (await client.flowRunRetry({ runId: input.runId })).run;
    },
    onSuccess: async (run) => {
      setRun(run);
      await refresh();
    },
  });
  const cancel = useMutation({
    mutationFn: async (runId: string) =>
      (await requireFlowClient(serverId).flowRunCancel({ runId })).run,
    onSuccess: setRun,
  });
  const retry = useMutation({
    mutationFn: async (runId: string) =>
      (await requireFlowClient(serverId).flowRunRetry({ runId })).run,
    onSuccess: setRun,
  });
  return useMemo(
    () => ({
      createFlow: create.mutateAsync,
      updateFlow: update.mutateAsync,
      deleteFlow: remove.mutateAsync,
      approveFlow: approve.mutateAsync,
      runApproveAndStart: approveAndStart.mutateAsync,
      cancelRun: cancel.mutateAsync,
      retryRun: retry.mutateAsync,
    }),
    [
      approve.mutateAsync,
      approveAndStart.mutateAsync,
      cancel.mutateAsync,
      create.mutateAsync,
      remove.mutateAsync,
      retry.mutateAsync,
      update.mutateAsync,
    ],
  );
}
