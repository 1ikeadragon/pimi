import { useMemo } from "react";
import type { TaskLink } from "@pimi/protocol/task/types";
import { useAggregatedAgents, type AggregatedAgent } from "@/hooks/use-aggregated-agents";

export interface TaskChat {
  serverId: string;
  agentId: string;
  workspaceId: string | null;
  title: string;
  provider: string;
}

export type TaskChatDirectory = ReadonlyMap<string, TaskChat>;

export function chatKey(serverId: string, agentId: string): string {
  return `${serverId}:${agentId}`;
}

/** The chat a link points at; a provider subagent resolves to its parent chat. */
export function linkedChatId(link: TaskLink): string {
  return link.kind === "agent" ? link.agentId : link.parentAgentId;
}

export function toTaskChat(agent: AggregatedAgent): TaskChat {
  return {
    serverId: agent.serverId,
    agentId: agent.id,
    workspaceId: agent.workspaceId ?? null,
    title: agent.title?.trim() || "Untitled chat",
    provider: agent.provider,
  };
}

/** Every chat on every host, keyed `serverId:agentId`, archived ones included so old links resolve. */
export function useChatDirectory(): { directory: TaskChatDirectory; chats: TaskChat[] } {
  const { agents } = useAggregatedAgents({ includeArchived: true });
  return useMemo(() => {
    const chats = agents.map(toTaskChat);
    return {
      directory: new Map(chats.map((chat) => [chatKey(chat.serverId, chat.agentId), chat])),
      chats,
    };
  }, [agents]);
}
