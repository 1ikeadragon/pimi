import { useMemo } from "react";
import type { ListTerminalsResponse } from "@pimi/protocol/messages";
import { useReplicaQuery } from "@/data/query";
import { workspaceTerminalsPushRoute } from "@/data/push-router";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { buildTerminalsQueryKey } from "@/screens/workspace/terminals/state";
import { useWorkspaceFields } from "@/stores/session-store-hooks";

type TerminalEntry = ListTerminalsResponse["payload"]["terminals"][number];

export interface AttackRunTerminal {
  id: string;
  ownerAgentId: string;
  title: string;
  terminal: TerminalEntry;
}

const NO_TERMINALS: AttackRunTerminal[] = [];

/**
 * Terminals a run's agents created through `create_terminal`, found by the daemon-recorded
 * `ownerAgentId`. Shares the workspace terminals query and its `terminals_changed` push, so it
 * adds no polling and no second subscription.
 */
export function useAttackRunTerminals(
  serverId: string,
  workspaceId: string,
  agentIds: readonly string[],
): { terminals: AttackRunTerminal[]; workspaceDirectory: string | null } {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const fields = useWorkspaceFields(serverId, workspaceId, (w) => ({
    workspaceDirectory: w.workspaceDirectory,
  }));
  const workspaceDirectory = fields?.workspaceDirectory || null;
  const enabled = Boolean(client && isConnected && workspaceDirectory);
  const query = useReplicaQuery({
    queryKey: buildTerminalsQueryKey(serverId, workspaceDirectory, workspaceId || null),
    enabled,
    pushEvent: "terminals_changed",
    meta: workspaceTerminalsPushRoute({
      enabled,
      serverId,
      cwd: workspaceDirectory ?? "",
      ...(workspaceId ? { workspaceId } : {}),
    }),
    queryFn: async () => {
      if (!client || !workspaceDirectory) throw new Error("Host disconnected");
      return await client.listTerminals(workspaceDirectory, undefined, {
        workspaceId: workspaceId || undefined,
      });
    },
  });
  const terminals = useMemo(() => {
    const members = new Set(agentIds);
    const owned: AttackRunTerminal[] = [];
    for (const terminal of query.data?.terminals ?? []) {
      if (!terminal.ownerAgentId || !members.has(terminal.ownerAgentId)) continue;
      owned.push({
        id: terminal.id,
        ownerAgentId: terminal.ownerAgentId,
        title: terminal.title?.trim() || terminal.name,
        terminal,
      });
    }
    return owned.length > 0 ? owned : NO_TERMINALS;
  }, [agentIds, query.data]);
  return { terminals, workspaceDirectory };
}
