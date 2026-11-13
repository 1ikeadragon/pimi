import { getParentAddressFromLabels } from "@pimi/protocol/agent-labels";
import type { ProviderSubagentDescriptorPayload } from "@pimi/protocol/messages";
import { PIMI_TASK_WORKER_LABEL } from "@pimi/protocol/pimi-task";
import type { Agent } from "@/stores/session-store";
import { chatStateBucket, isVisibleChatAgent } from "@/chats/primary-chat";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import {
  isLiveSubagentStatus,
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

/** A root chat in a workspace and the children it started that still want a look. */
export interface SidebarLineageChat {
  serverId: string;
  agentId: string;
  title: string | null;
  /** The chat's own state, as its workspace row would show it. */
  bucket: SidebarStateBucket;
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

const EMPTY_CHATS: SidebarLineageChat[] = [];

export function sidebarLineageWorkspaceKey(serverId: string, workspaceId: string): string {
  return `${serverId}:${workspaceId}`;
}

interface ChatEntry {
  parent: Agent;
  workers: Array<{ createdAt: number; worker: SidebarLineageWorker }>;
}

/**
 * Every workspace's chats that have live children, keyed by `sidebarLineageWorkspaceKey`. One
 * pass over the agents and the provider descriptors, plus a sort per chat.
 *
 * The lineage is a quiet projection of each chat's subagents track (`select.ts`): the same
 * managed and provider children, minus the finished ones. A child stays while it is working,
 * needs input or has failed (`./status.ts`); once it is done it leaves the sidebar, and a chat
 * with no such child has no row, because the parent's own finish already carries the news.
 *
 * A chat is listed under its own workspace only when it is a workspace root there, so a
 * same-workspace subagent never appears both as a worker and as a chat of its own; its own
 * children stay one click away in its track. A Pimi task worker in another workspace is left out
 * because the sidebar already nests that workspace under the chat's workspace.
 */
export function buildSidebarLineageIndex(
  sessions: Readonly<Record<string, SessionAgents>>,
  providers: ProviderSubagentsSnapshot,
): Map<string, SidebarLineageChat[]> {
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
  if (agent.labels[PIMI_TASK_WORKER_LABEL] && agent.workspaceId !== parent.workspaceId) {
    return null;
  }
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
      if (!isLiveSubagentStatus(bucket)) continue;
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
    if (!isLiveSubagentStatus(bucket)) continue;
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
): Map<string, SidebarLineageChat[]> {
  const byWorkspace = new Map<string, ChatEntry[]>();
  for (const entry of chats.values()) {
    const { parent } = entry;
    const grandparent = parent.parentAgentId
      ? sessions[parent.serverId]?.agents.get(parent.parentAgentId)
      : undefined;
    if (!isWorkspaceRootAgent(parent, grandparent)) continue;
    const key = sidebarLineageWorkspaceKey(parent.serverId, parent.workspaceId ?? "");
    const list = byWorkspace.get(key);
    if (list) list.push(entry);
    else byWorkspace.set(key, [entry]);
  }

  const result = new Map<string, SidebarLineageChat[]>();
  for (const [key, entries] of byWorkspace) {
    entries.sort(
      (left, right) => left.parent.createdAt.getTime() - right.parent.createdAt.getTime(),
    );
    result.set(
      key,
      entries.map(({ parent, workers }) => ({
        serverId: parent.serverId,
        agentId: parent.id,
        title: parent.title,
        bucket: chatStateBucket(parent),
        workers: workers
          .sort((left, right) => left.createdAt - right.createdAt)
          .map(({ worker }) => worker),
      })),
    );
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
let cachedIndex: Map<string, SidebarLineageChat[]> | null = null;

function getSidebarLineageIndex(
  sessions: Readonly<Record<string, SessionAgents>>,
  providers: ProviderSubagentsSnapshot,
): Map<string, SidebarLineageChat[]> {
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

export function selectSidebarLineageChats(
  sessions: Readonly<Record<string, SessionAgents>>,
  providers: ProviderSubagentsSnapshot,
  workspaceKey: string,
): SidebarLineageChat[] {
  return getSidebarLineageIndex(sessions, providers).get(workspaceKey) ?? EMPTY_CHATS;
}
