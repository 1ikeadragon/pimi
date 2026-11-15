import equal from "fast-deep-equal";
import { useCallback } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { isWorkspaceRootAgent } from "@/subagents/workspace-root-policy";
import { resolveRowLabel } from "@/subagents/track-presentation";
import { type Agent, useSessionStore } from "@/stores/session-store";

/**
 * A chat as the UI names it: the root agent of a workspace. The workspace record is the chat's
 * hidden environment, and every other agent in it is one of the chat's subagents.
 */
export interface WorkspaceChat {
  serverId: string;
  agentId: string;
  /** The agent's own title, unresolved. Pass it through `resolveChatTitle` for display. */
  title: string | null;
  createdAt: number;
}

interface SessionAgents {
  agents: ReadonlyMap<string, Agent>;
}

function workspaceChatKey(serverId: string, workspaceId: string): string {
  return `${serverId}:${workspaceId}`;
}

export function isVisibleChatAgent(agent: Agent): boolean {
  return !agent.archivedAt && !agent.background;
}

function buildChatIndex(
  sessions: Readonly<Record<string, SessionAgents>>,
): Map<string, WorkspaceChat> {
  const index = new Map<string, WorkspaceChat>();
  for (const [serverId, session] of Object.entries(sessions)) {
    for (const agent of session.agents.values()) {
      if (!agent.workspaceId || !isVisibleChatAgent(agent)) continue;
      const parent = agent.parentAgentId ? session.agents.get(agent.parentAgentId) : undefined;
      if (!isWorkspaceRootAgent(agent, parent)) continue;
      const key = workspaceChatKey(serverId, agent.workspaceId);
      const createdAt = agent.createdAt.getTime();
      const current = index.get(key);
      if (current && current.createdAt <= createdAt) continue;
      index.set(key, { serverId, agentId: agent.id, title: agent.title, createdAt });
    }
  }
  return index;
}

/**
 * The session store notifies on every stream tick and every sidebar row selects through this, so
 * the index is rebuilt only when an agent map is replaced and shared by all rows.
 */
let cachedMaps: Array<ReadonlyMap<string, Agent>> = [];
let cachedServerIds: string[] = [];
let cachedIndex: Map<string, WorkspaceChat> | null = null;

function getChatIndex(
  sessions: Readonly<Record<string, SessionAgents>>,
): Map<string, WorkspaceChat> {
  const serverIds = Object.keys(sessions);
  const unchanged =
    cachedIndex !== null &&
    serverIds.length === cachedServerIds.length &&
    serverIds.every(
      (serverId, index) =>
        cachedServerIds[index] === serverId && cachedMaps[index] === sessions[serverId]?.agents,
    );
  if (unchanged && cachedIndex) return cachedIndex;
  cachedServerIds = serverIds;
  cachedMaps = serverIds.map((serverId) => sessions[serverId]?.agents ?? new Map());
  cachedIndex = buildChatIndex(sessions);
  return cachedIndex;
}

/** The workspace's chat, or null while it has no agent. */
export function selectWorkspaceChat(
  sessions: Readonly<Record<string, SessionAgents>>,
  serverId: string,
  workspaceId: string,
): WorkspaceChat | null {
  return getChatIndex(sessions).get(workspaceChatKey(serverId, workspaceId)) ?? null;
}

export function useWorkspaceChat(
  serverId: string | null | undefined,
  workspaceId: string | null | undefined,
): WorkspaceChat | null {
  const select = useCallback(
    (state: ReturnType<typeof useSessionStore.getState>) =>
      serverId && workspaceId ? selectWorkspaceChat(state.sessions, serverId, workspaceId) : null,
    [serverId, workspaceId],
  );
  return useStoreWithEqualityFn(useSessionStore, select, equal);
}

/** The chat agent's title, then the workspace's own title, then the fallback. */
export function resolveChatTitle(input: {
  chatTitle: string | null | undefined;
  workspaceTitle: string | null | undefined;
  fallback: string;
}): string {
  return (
    resolveRowLabel(input.chatTitle) ?? resolveRowLabel(input.workspaceTitle) ?? input.fallback
  );
}
