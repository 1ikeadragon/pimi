import equal from "fast-deep-equal";
import { useCallback } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { isWorkspaceRootAgent } from "@/subagents/workspace-root-policy";
import { resolveRowLabel } from "@/subagents/track-presentation";
import { type Agent, useSessionStore } from "@/stores/session-store";
import { deriveSidebarStateBucket, type SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { workspaceAgentStatus } from "@/utils/workspace-agent-activity";

/**
 * A chat as the UI names it: a visible root agent of a workspace. The workspace record is the
 * chat's hidden environment, so the first chat in it supplies the row label, header title and
 * rename target.
 */
export interface WorkspaceRootChat {
  serverId: string;
  agentId: string;
  /** The agent's own title, unresolved. Pass it through `resolveChatTitle` for display. */
  title: string | null;
  createdAt: number;
  bucket: SidebarStateBucket;
}

interface SessionAgents {
  agents: ReadonlyMap<string, Agent>;
}

const EMPTY_CHATS: WorkspaceRootChat[] = [];

export function workspaceChatsKey(serverId: string, workspaceId: string): string {
  return `${serverId}:${workspaceId}`;
}

export function isVisibleChatAgent(agent: Agent): boolean {
  return !agent.archivedAt && !agent.background;
}

export function chatStateBucket(agent: Agent): SidebarStateBucket {
  return deriveSidebarStateBucket({
    status: workspaceAgentStatus(agent),
    backgroundWork: agent.backgroundWork,
    pendingPermissionCount: agent.pendingPermissions.length,
    requiresAttention: agent.requiresAttention,
    attentionReason: agent.attentionReason,
  });
}

function buildRootChatIndex(
  sessions: Readonly<Record<string, SessionAgents>>,
): Map<string, WorkspaceRootChat[]> {
  const index = new Map<string, WorkspaceRootChat[]>();
  for (const [serverId, session] of Object.entries(sessions)) {
    for (const agent of session.agents.values()) {
      if (!agent.workspaceId || !isVisibleChatAgent(agent)) continue;
      const parent = agent.parentAgentId ? session.agents.get(agent.parentAgentId) : undefined;
      if (!isWorkspaceRootAgent(agent, parent)) continue;
      const key = workspaceChatsKey(serverId, agent.workspaceId);
      const chat: WorkspaceRootChat = {
        serverId,
        agentId: agent.id,
        title: agent.title,
        createdAt: agent.createdAt.getTime(),
        bucket: chatStateBucket(agent),
      };
      const list = index.get(key);
      if (list) list.push(chat);
      else index.set(key, [chat]);
    }
  }
  for (const list of index.values()) {
    list.sort((left, right) => left.createdAt - right.createdAt);
  }
  return index;
}

/**
 * The session store notifies on every stream tick and every sidebar row selects through this, so
 * the index is rebuilt only when an agent map is replaced and shared by all rows.
 */
let cachedMaps: Array<ReadonlyMap<string, Agent>> = [];
let cachedServerIds: string[] = [];
let cachedIndex: Map<string, WorkspaceRootChat[]> | null = null;

function getRootChatIndex(
  sessions: Readonly<Record<string, SessionAgents>>,
): Map<string, WorkspaceRootChat[]> {
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
  cachedIndex = buildRootChatIndex(sessions);
  return cachedIndex;
}

/** Visible root chats of a workspace, oldest first. The first is the primary chat. */
export function selectWorkspaceRootChats(
  sessions: Readonly<Record<string, SessionAgents>>,
  serverId: string,
  workspaceId: string,
): WorkspaceRootChat[] {
  return getRootChatIndex(sessions).get(workspaceChatsKey(serverId, workspaceId)) ?? EMPTY_CHATS;
}

export function useWorkspaceRootChats(
  serverId: string | null | undefined,
  workspaceId: string | null | undefined,
): WorkspaceRootChat[] {
  const select = useCallback(
    (state: ReturnType<typeof useSessionStore.getState>) =>
      serverId && workspaceId
        ? selectWorkspaceRootChats(state.sessions, serverId, workspaceId)
        : EMPTY_CHATS,
    [serverId, workspaceId],
  );
  return useStoreWithEqualityFn(useSessionStore, select, equal);
}

export function useWorkspacePrimaryChat(
  serverId: string | null | undefined,
  workspaceId: string | null | undefined,
): WorkspaceRootChat | null {
  const select = useCallback(
    (state: ReturnType<typeof useSessionStore.getState>) =>
      serverId && workspaceId
        ? (selectWorkspaceRootChats(state.sessions, serverId, workspaceId)[0] ?? null)
        : null,
    [serverId, workspaceId],
  );
  return useStoreWithEqualityFn(useSessionStore, select, equal);
}

/** Primary chat title, then the workspace's own title, then the fallback. */
export function resolveChatTitle(input: {
  primaryTitle: string | null | undefined;
  workspaceTitle: string | null | undefined;
  fallback: string;
}): string {
  return (
    resolveRowLabel(input.primaryTitle) ?? resolveRowLabel(input.workspaceTitle) ?? input.fallback
  );
}
