import { getParentAddressFromLabels } from "@pimi/protocol/agent-labels";
import type { ProviderSubagentDescriptorPayload } from "@pimi/protocol/messages";
import type { Agent } from "@/stores/session-store";
import { isVisibleChatAgent } from "@/chats/workspace-chat";
import {
  managedSubagentStatusBucket,
  providerSubagentStatusBucket,
  type SubagentStatusBucket,
} from "./status";
import { resolveRowLabel } from "./track-presentation";
import { isWorkspaceRootAgent } from "./workspace-root-policy";

/** One child as the sidebar lineage draws it. Only fields the row paints, so equality stays cheap. */
export type SidebarLineageWorker =
  | {
      kind: "agent";
      serverId: string;
      agentId: string;
      provider: Agent["provider"];
      title: string | null;
      bucket: SubagentStatusBucket;
    }
  | {
      kind: "provider";
      serverId: string;
      workspaceId: string;
      parentAgentId: string;
      subagentId: string;
      provider: ProviderSubagentDescriptorPayload["provider"];
      title: string | null;
      bucket: SubagentStatusBucket;
    };

/** A workspace's chat and the children it started. */
export interface SidebarLineage {
  serverId: string;
  /** The chat's agent. */
  agentId: string;
  workers: SidebarLineageWorker[];
}

interface SessionAgents {
  agents: ReadonlyMap<string, Agent>;
}

/** The slice of the provider-subagent store the lineage reads. */
export interface ProviderSubagentsSnapshot {
  descriptors: ReadonlyMap<string, ProviderSubagentDescriptorPayload>;
  hiddenFromTrack: ReadonlySet<string>;
}

export function sidebarLineageWorkspaceKey(serverId: string, workspaceId: string): string {
  return `${serverId}:${workspaceId}`;
}

interface ChatEntry {
  parent: Agent;
  workers: Array<{ createdAt: number; worker: SidebarLineageWorker }>;
}

/**
 * Every workspace whose chat has children, keyed by `sidebarLineageWorkspaceKey`. One pass
 * over the agents and the provider descriptors, plus a sort per chat.
 *
 * The lineage is a quiet projection of each chat's subagents track (`select.ts`): the same
 * managed and provider children, finished ones included with their Done status. Archived and
 * hidden children stay out, and the workspace's Hide nested toggle folds the rest.
 *
 * Only the workspace's root agent is its chat, so a subagent never appears both as a worker and
 * as a chat of its own; its own children stay one click away in its track.
 */
export function buildSidebarLineageIndex(
  sessions: Readonly<Record<string, SessionAgents>>,
  providers: ProviderSubagentsSnapshot,
): Map<string, SidebarLineage> {
  const chats = new Map<string, ChatEntry>();
  collectManagedChildren(sessions, chats);
  collectProviderChildren(sessions, providers, chats);
  return groupChatsByWorkspace(sessions, chats);
}

function addWorker(
  chats: Map<string, ChatEntry>,
  parent: Agent,
  createdAt: number,
  worker: SidebarLineageWorker,
): void {
  const key = `${parent.serverId}:${parent.id}`;
  const entry = chats.get(key);
  if (entry) entry.workers.push({ createdAt, worker });
  else chats.set(key, { parent, workers: [{ createdAt, worker }] });
}

/** The parent a managed child is listed under, or null when the lineage leaves the child out. */
function lineageParent(
  sessions: Readonly<Record<string, SessionAgents>>,
  serverId: string,
  agent: Agent,
): Agent | null {
  if (!isVisibleChatAgent(agent)) return null;
  const address = getParentAddressFromLabels(agent.labels, serverId);
  if (!address) return null;
  const parent = sessions[address.serverId]?.agents.get(address.agentId);
  if (!parent || !isVisibleChatAgent(parent) || !parent.workspaceId) return null;
  return parent;
}

function collectManagedChildren(
  sessions: Readonly<Record<string, SessionAgents>>,
  chats: Map<string, ChatEntry>,
): void {
  for (const [serverId, session] of Object.entries(sessions)) {
    for (const agent of session.agents.values()) {
      const parent = lineageParent(sessions, serverId, agent);
      if (!parent) continue;
      const bucket = managedSubagentStatusBucket(agent);
      addWorker(chats, parent, agent.createdAt.getTime(), {
        kind: "agent",
        serverId: agent.serverId,
        agentId: agent.id,
        provider: agent.provider,
        title: agent.title,
        bucket,
      });
    }
  }
}

function collectProviderChildren(
  sessions: Readonly<Record<string, SessionAgents>>,
  providers: ProviderSubagentsSnapshot,
  chats: Map<string, ChatEntry>,
): void {
  for (const [key, descriptor] of providers.descriptors) {
    // Nested provider children live in their own parent's track, as they do in the panel.
    if (descriptor.parentSubagentId || providers.hiddenFromTrack.has(key)) continue;
    const bucket = providerSubagentStatusBucket(descriptor.status);
    const serverId = key.slice(0, key.indexOf("\0"));
    const parent = sessions[serverId]?.agents.get(descriptor.parentAgentId);
    if (!parent || !isVisibleChatAgent(parent) || !parent.workspaceId) continue;
    addWorker(chats, parent, Date.parse(descriptor.createdAt), {
      kind: "provider",
      serverId,
      workspaceId: parent.workspaceId,
      parentAgentId: descriptor.parentAgentId,
      subagentId: descriptor.id,
      provider: descriptor.provider,
      title: resolveRowLabel(descriptor.description) ?? resolveRowLabel(descriptor.title),
      bucket,
    });
  }
}

function groupChatsByWorkspace(
  sessions: Readonly<Record<string, SessionAgents>>,
  chats: ReadonlyMap<string, ChatEntry>,
): Map<string, SidebarLineage> {
  const result = new Map<string, SidebarLineage>();
  for (const { parent, workers } of chats.values()) {
    const grandparent = parent.parentAgentId
      ? sessions[parent.serverId]?.agents.get(parent.parentAgentId)
      : undefined;
    if (!isWorkspaceRootAgent(parent, grandparent)) continue;
    result.set(sidebarLineageWorkspaceKey(parent.serverId, parent.workspaceId ?? ""), {
      serverId: parent.serverId,
      agentId: parent.id,
      workers: workers
        .sort((left, right) => left.createdAt - right.createdAt)
        .map(({ worker }) => worker),
    });
  }
  return result;
}

/**
 * The session store notifies on every stream tick, and every workspace row runs its selector on
 * each one. The index is rebuilt only when an agent map or the provider descriptors are replaced,
 * and shared by all rows, so a row's selector is a few identity checks and a map lookup.
 */
let cachedMaps: Array<ReadonlyMap<string, Agent>> = [];
let cachedServerIds: string[] = [];
let cachedProviders: ProviderSubagentsSnapshot | null = null;
let cachedIndex: Map<string, SidebarLineage> | null = null;

function getSidebarLineageIndex(
  sessions: Readonly<Record<string, SessionAgents>>,
  providers: ProviderSubagentsSnapshot,
): Map<string, SidebarLineage> {
  const serverIds = Object.keys(sessions);
  const unchanged =
    cachedIndex !== null &&
    cachedProviders?.descriptors === providers.descriptors &&
    cachedProviders.hiddenFromTrack === providers.hiddenFromTrack &&
    serverIds.length === cachedServerIds.length &&
    serverIds.every(
      (serverId, index) =>
        cachedServerIds[index] === serverId && cachedMaps[index] === sessions[serverId]?.agents,
    );
  if (unchanged && cachedIndex) return cachedIndex;
  cachedServerIds = serverIds;
  cachedMaps = serverIds.map((serverId) => sessions[serverId]?.agents ?? new Map());
  cachedProviders = providers;
  cachedIndex = buildSidebarLineageIndex(sessions, providers);
  return cachedIndex;
}

export function selectSidebarLineage(
  sessions: Readonly<Record<string, SessionAgents>>,
  providers: ProviderSubagentsSnapshot,
  workspaceKey: string,
): SidebarLineage | null {
  return getSidebarLineageIndex(sessions, providers).get(workspaceKey) ?? null;
}
