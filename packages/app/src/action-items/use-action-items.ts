import { useCallback, useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ActionItemsEdit, ActionItemsState } from "@pimi/protocol/action-items/types";
import { useReplicaQuery } from "@/data/query";
import { useTranslation } from "@/i18n/use-translation";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

function actionItemsQueryKey(serverId: string, agentId: string | null) {
  return ["action-items", serverId, agentId] as const;
}

export interface UseActionItemsResult {
  state: ActionItemsState | null;
  isConnected: boolean;
  loadError: string | null;
  edit: (edit: ActionItemsEdit) => Promise<void>;
}

/**
 * One chat's action items. The daemon pushes the whole list on every change, from this client,
 * another client or the model, so the cache is replaced and never patched locally. `active`
 * false (a hidden panel) drops the subscription.
 */
export function useActionItems(input: {
  serverId: string;
  agentId: string | null;
  active: boolean;
}): UseActionItemsResult {
  const { serverId, agentId, active } = input;
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const queryKey = useMemo(() => actionItemsQueryKey(serverId, agentId), [serverId, agentId]);
  const enabled = Boolean(active && agentId && client && isConnected);

  const query = useReplicaQuery({
    queryKey,
    enabled,
    pushEvent: "agent.action_items.update",
    queryFn: async () => {
      if (!client || !agentId) throw new Error(t("workspace.terminal.hostDisconnected"));
      return (await client.getAgentActionItems({ agentId })).state;
    },
  });

  useEffect(() => {
    if (!enabled || !client || !agentId) return;
    const observation = client.observeAgentActionItems();
    observation.subscribe({
      // Fires on every (re)connect: pushes missed while offline are gone, so read again.
      snapshot: () => {
        void queryClient.invalidateQueries({ queryKey });
      },
      update: (message) => {
        if (message.type !== "agent.action_items.update") return;
        if (message.payload.agentId !== agentId) return;
        queryClient.setQueryData(queryKey, message.payload);
      },
    });
    return () => {
      void observation.release().catch(() => undefined);
    };
  }, [agentId, client, enabled, queryClient, queryKey]);

  const edit = useCallback(
    async (change: ActionItemsEdit) => {
      if (!client || !agentId) throw new Error(t("workspace.terminal.hostDisconnected"));
      const { state } = await client.editAgentActionItems({ agentId, edit: change });
      queryClient.setQueryData(queryKey, state);
    },
    [agentId, client, queryClient, queryKey, t],
  );

  return {
    state: query.data ?? null,
    isConnected,
    loadError: query.error ? query.error.message : null,
    edit,
  };
}
