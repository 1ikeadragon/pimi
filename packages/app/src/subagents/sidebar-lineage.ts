import { getParentAddressFromLabels } from "@pimi/protocol/agent-labels";
import { PIMI_TASK_WORKER_LABEL } from "@pimi/protocol/pimi-task";
import type { Agent } from "@/stores/session-store";
import { deriveSidebarStateBucket, type SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { workspaceAgentStatus } from "@/utils/workspace-agent-activity";
import { isWorkspaceRootAgent } from "./workspace-root-policy";

/** One agent as the sidebar lineage draws it. Only fields the row paints, so equality stays cheap. */
export interface SidebarLineageAgent {
  serverId: string;
  agentId: string;
  provider: Agent["provider"];
  title: string | null;
  bucket: SidebarStateBucket;
}

/** A chat in a workspace and the managed subagents it started. */
export interface SidebarLineageChat extends SidebarLineageAgent {
  workers: SidebarLineageAgent[];
}

interface SessionAgents {
  agents: ReadonlyMap<string, Agent>;
}

const EMPTY_CHATS: SidebarLineageChat[] = [];

export function sidebarLineageWorkspaceKey(serverId: string, workspaceId: string): string {
  return `${serverId}:${workspaceId}`;
}

function isVisible(agent: Agent): boolean {
  return !agent.archivedAt && !agent.background;
}

/**
 * Lifecycle error stays visible here as it does in the subagents track: a failed child is the
 * thing the lineage exists to surface, so it does not wait for unread attention.
 */
function lineageBucket(agent: Agent): SidebarStateBucket {
  const status = workspaceAgentStatus(agent);
  const bucket = deriveSidebarStateBucket({
    status,
    backgroundWork: agent.backgroundWork,
    pendingPermissionCount: agent.pendingPermissions.length,
    requiresAttention: agent.requiresAttention,
    attentionReason: agent.attentionReason,
  });
  return bucket === "done" && status === "error" ? "failed" : bucket;
}

function toLineageAgent(agent: Agent): SidebarLineageAgent {
  return {
    serverId: agent.serverId,
    agentId: agent.id,
    provider: agent.provider,
    title: agent.title,
    bucket: lineageBucket(agent),
  };
}

function byCreatedAt(left: Agent, right: Agent): number {
  return left.createdAt.getTime() - right.createdAt.getTime();
}

/**
 * Every workspace's chats that have visible managed subagents, keyed by
 * `sidebarLineageWorkspaceKey`. One pass over the agents plus a sort per chat.
 *
 * Membership follows the track (`select.ts`): the parent comes from the parent labels and
 * archived or background children are left out. A chat is listed under its own workspace only
 * when it is a workspace root there, so a same-workspace subagent never appears both as a worker
 * and as a chat of its own; its own children stay one click away in its track. A Pimi task worker
 * in another workspace is left out because the sidebar already nests that workspace under the
 * chat's workspace.
 */
export function buildSidebarLineageIndex(
  sessions: Readonly<Record<string, SessionAgents>>,
): Map<string, SidebarLineageChat[]> {
  const childrenByParent = new Map<string, { parent: Agent; children: Agent[] }>();
  for (const [serverId, session] of Object.entries(sessions)) {
    for (const agent of session.agents.values()) {
      if (!isVisible(agent)) continue;
      const address = getParentAddressFromLabels(agent.labels, serverId);
      if (!address) continue;
      const parent = sessions[address.serverId]?.agents.get(address.agentId);
      if (!parent || !isVisible(parent) || !parent.workspaceId) continue;
      if (agent.labels[PIMI_TASK_WORKER_LABEL] && agent.workspaceId !== parent.workspaceId) {
        continue;
      }
      const key = `${address.serverId}:${address.agentId}`;
      const entry = childrenByParent.get(key);
      if (entry) entry.children.push(agent);
      else childrenByParent.set(key, { parent, children: [agent] });
    }
  }

  const index = new Map<string, Array<{ parent: Agent; children: Agent[] }>>();
  for (const entry of childrenByParent.values()) {
    const { parent } = entry;
    const grandparent = parent.parentAgentId
      ? sessions[parent.serverId]?.agents.get(parent.parentAgentId)
      : undefined;
    if (!isWorkspaceRootAgent(parent, grandparent)) continue;
    const key = sidebarLineageWorkspaceKey(parent.serverId, parent.workspaceId ?? "");
    const chats = index.get(key);
    if (chats) chats.push(entry);
    else index.set(key, [entry]);
  }

  const result = new Map<string, SidebarLineageChat[]>();
  for (const [key, entries] of index) {
    entries.sort((left, right) => byCreatedAt(left.parent, right.parent));
    result.set(
      key,
      entries.map(({ parent, children }) =>
        Object.assign(toLineageAgent(parent), {
          workers: children.sort(byCreatedAt).map(toLineageAgent),
        }),
      ),
    );
  }
  return result;
}

/**
 * The session store notifies on every stream tick, and every workspace row runs its selector on
 * each one. The index is rebuilt only when an agent map is replaced, and shared by all rows, so a
 * row's selector is a few identity checks and a map lookup.
 */
let cachedMaps: Array<ReadonlyMap<string, Agent>> = [];
let cachedServerIds: string[] = [];
let cachedIndex: Map<string, SidebarLineageChat[]> | null = null;

function getSidebarLineageIndex(
  sessions: Readonly<Record<string, SessionAgents>>,
): Map<string, SidebarLineageChat[]> {
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
  cachedIndex = buildSidebarLineageIndex(sessions);
  return cachedIndex;
}

export function selectSidebarLineageChats(
  sessions: Readonly<Record<string, SessionAgents>>,
  workspaceKey: string,
): SidebarLineageChat[] {
  return getSidebarLineageIndex(sessions).get(workspaceKey) ?? EMPTY_CHATS;
}
