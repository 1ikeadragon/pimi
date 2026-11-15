import { randomBytes } from "node:crypto";
import { access, chmod, rename, rm } from "node:fs/promises";
import type { Logger } from "pino";
import { PARENT_AGENT_ID_LABEL } from "@pimi/protocol/agent-labels";
import type { PimiDatabase } from "./pimi-db.js";

// Builds before 0.17.62 let one workspace record hold several root chats. A workspace is now one
// chat: its root agent plus that agent's subagents. This one-time step gives every extra root chat
// a workspace record of its own in the same project, with the same directory and git placement,
// and moves the chat's subagents with it.
//
// It only rewrites `workspace_id` on agent rows and inserts workspace rows. It never deletes or
// archives an agent, and never touches timelines, worktrees or files. A full copy of pimi.db is
// written beside it first; the rewrite is one transaction that verifies its own result and rolls
// back on any difference, leaving the daemon on the old data to try again at the next start.

const META_KEY = "split_multi_chat_workspaces";
export const CHAT_SPLIT_BACKUP_SUFFIX = ".pre-chat-split";

type Row = Record<string, string | number | bigint | null | Uint8Array>;

interface AgentRow {
  id: string;
  workspaceId: string;
  archivedAt: string | null;
  hidden: boolean;
  parentId: string | null;
  createdAt: number;
  title: string | null;
}

interface WorkspaceRow {
  id: string;
  json: Record<string, unknown>;
}

export interface ChatSplitResult {
  /** False when an earlier start already completed the step. */
  ran: boolean;
  workspacesSplit: number;
  workspacesCreated: number;
  agentsMoved: number;
  backupPath: string | null;
}

interface Snapshot {
  agents: Map<string, AgentRow>;
  workspaces: Map<string, WorkspaceRow>;
  totalAgents: number;
  liveAgents: number;
  totalWorkspaces: number;
}

function readSnapshot(database: PimiDatabase): Snapshot {
  const db = database.db;
  const agents = new Map<string, AgentRow>();
  const rows = db
    .prepare(
      `SELECT id, workspace_id, archived_at, internal, background,
         json_extract(json, '$.labels."${PARENT_AGENT_ID_LABEL}"') AS parent_id,
         json_extract(json, '$.createdAt') AS created_at,
         json_extract(json, '$.title') AS title
       FROM agents WHERE workspace_id IS NOT NULL ORDER BY rowid`,
    )
    .all() as Row[];
  for (const row of rows) {
    const parentId = typeof row.parent_id === "string" ? row.parent_id.trim() : "";
    const createdAt = Date.parse(String(row.created_at ?? ""));
    agents.set(String(row.id), {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      archivedAt: row.archived_at ? String(row.archived_at) : null,
      hidden: Number(row.internal) === 1 || Number(row.background) === 1,
      parentId: parentId || null,
      createdAt: Number.isNaN(createdAt) ? 0 : createdAt,
      title: typeof row.title === "string" && row.title.trim() ? row.title : null,
    });
  }
  const workspaces = new Map<string, WorkspaceRow>();
  for (const row of db
    .prepare("SELECT id, json FROM records WHERE kind = 'workspace' ORDER BY rowid")
    .all() as Row[]) {
    try {
      const json = JSON.parse(String(row.json)) as unknown;
      if (json && typeof json === "object" && !Array.isArray(json)) {
        workspaces.set(String(row.id), {
          id: String(row.id),
          json: json as Record<string, unknown>,
        });
      }
    } catch {
      // The registry skips a row it cannot read; so does the split.
    }
  }
  const count = (sql: string) => Number((db.prepare(sql).get() as Row).n);
  return {
    agents,
    workspaces,
    totalAgents: count("SELECT COUNT(*) AS n FROM agents"),
    liveAgents: count("SELECT COUNT(*) AS n FROM agents WHERE archived_at IS NULL"),
    totalWorkspaces: count("SELECT COUNT(*) AS n FROM records WHERE kind = 'workspace'"),
  };
}

// A chat's root, as every client has drawn it: a visible agent with no parent, or one whose parent
// lives in another workspace. An agent whose parent is not stored here is left where it is.
function isRoot(agent: AgentRow, agents: ReadonlyMap<string, AgentRow>): boolean {
  if (agent.hidden) return false;
  if (!agent.parentId) return true;
  const parent = agents.get(agent.parentId);
  return parent !== undefined && parent.workspaceId !== agent.workspaceId;
}

function rootsByWorkspace(agents: ReadonlyMap<string, AgentRow>): Map<string, AgentRow[]> {
  const roots = new Map<string, AgentRow[]>();
  for (const agent of agents.values()) {
    if (!isRoot(agent, agents)) continue;
    const list = roots.get(agent.workspaceId);
    if (list) list.push(agent);
    else roots.set(agent.workspaceId, [agent]);
  }
  for (const list of roots.values()) {
    list.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  }
  return roots;
}

/** The root and every agent below it that shares its workspace. */
function collectTree(root: AgentRow, agents: ReadonlyMap<string, AgentRow>): AgentRow[] {
  const children = new Map<string, AgentRow[]>();
  for (const agent of agents.values()) {
    if (!agent.parentId || agent.workspaceId !== root.workspaceId) continue;
    const list = children.get(agent.parentId);
    if (list) list.push(agent);
    else children.set(agent.parentId, [agent]);
  }
  const tree: AgentRow[] = [];
  const seen = new Set<string>();
  const queue = [root];
  for (let next = queue.shift(); next; next = queue.shift()) {
    if (seen.has(next.id)) continue;
    seen.add(next.id);
    tree.push(next);
    queue.push(...(children.get(next.id) ?? []));
  }
  return tree;
}

function newWorkspaceId(taken: ReadonlySet<string>): string {
  for (;;) {
    const id = `wks_${randomBytes(8).toString("hex")}`;
    if (!taken.has(id)) return id;
  }
}

/** Whether a chat is listed: its agent is not archived and its workspace record is active. */
function isListed(agent: AgentRow, workspaces: ReadonlyMap<string, WorkspaceRow>): boolean {
  const workspace = workspaces.get(agent.workspaceId);
  return !agent.archivedAt && workspace !== undefined && !workspace.json.archivedAt;
}

function listedRootIds(snapshot: Snapshot): string[] {
  const ids: string[] = [];
  for (const agent of snapshot.agents.values()) {
    if (isRoot(agent, snapshot.agents) && isListed(agent, snapshot.workspaces)) ids.push(agent.id);
  }
  return ids.sort();
}

function split(database: PimiDatabase, before: Snapshot, now: string) {
  const db = database.db;
  const takenIds = new Set(before.workspaces.keys());
  const moveAgent = db.prepare(
    "UPDATE agents SET workspace_id = ?, json = json_set(json, '$.workspaceId', ?) WHERE id = ?",
  );
  const insertWorkspace = db.prepare(
    "INSERT INTO records (kind, id, parent_id, json) VALUES ('workspace', ?, NULL, ?)",
  );
  const moveRuns = db.prepare(
    `UPDATE records SET json = json_set(json, '$.workspaceId', ?)
     WHERE json_extract(json, '$.workspaceId') = ?
       AND ((kind = 'flow_run' AND json_extract(json, '$.agentId') = ?)
         OR (kind = 'attack_run' AND json_extract(json, '$.leadAgentId') = ?))`,
  );
  let workspacesSplit = 0;
  let workspacesCreated = 0;
  let agentsMoved = 0;
  for (const [workspaceId, roots] of rootsByWorkspace(before.agents)) {
    const source = before.workspaces.get(workspaceId);
    if (roots.length < 2 || !source) continue;
    // The record stays with the chat that owned its sidebar row: the oldest one still open.
    const keeper = roots.find((root) => !root.archivedAt) ?? roots[0];
    workspacesSplit += 1;
    for (const root of roots) {
      if (root === keeper) continue;
      const id = newWorkspaceId(takenIds);
      takenIds.add(id);
      const { titleManuallySet: _titleManuallySet, ...placement } = source.json;
      const tree = collectTree(root, before.agents);
      insertWorkspace.run(
        id,
        JSON.stringify({
          ...placement,
          workspaceId: id,
          title: root.title,
          createdAt: root.createdAt ? new Date(root.createdAt).toISOString() : now,
          updatedAt: now,
          // A chat whose agents are all archived stays out of the sidebar, and a chat of an archived
          // record stays hidden with it. One open agent keeps the record open, as it was.
          archivedAt:
            source.json.archivedAt ??
            (tree.every((agent) => agent.archivedAt) ? root.archivedAt : null),
        }),
      );
      workspacesCreated += 1;
      for (const agent of tree) {
        moveAgent.run(id, id, agent.id);
        // Flow and Attack runs an agent started follow it.
        moveRuns.run(id, workspaceId, agent.id, agent.id);
        agentsMoved += 1;
      }
    }
  }
  return { workspacesSplit, workspacesCreated, agentsMoved };
}

function verify(before: Snapshot, after: Snapshot, created: number): void {
  const fail = (message: string): never => {
    throw new Error(`Chat split check failed: ${message}`);
  };
  if (after.totalAgents !== before.totalAgents) {
    fail(`agent count went from ${before.totalAgents} to ${after.totalAgents}`);
  }
  if (after.liveAgents !== before.liveAgents) {
    fail(`open agent count went from ${before.liveAgents} to ${after.liveAgents}`);
  }
  if (after.totalWorkspaces !== before.totalWorkspaces + created) {
    fail(
      `workspace count is ${after.totalWorkspaces}, expected ${before.totalWorkspaces + created}`,
    );
  }
  for (const [id, agent] of before.agents) {
    const moved = after.agents.get(id);
    if (!moved) fail(`agent ${id} lost its workspace`);
    else if (moved.archivedAt !== agent.archivedAt) fail(`agent ${id} changed archive state`);
    else if (moved.parentId !== agent.parentId) fail(`agent ${id} changed parent`);
    else if (!after.workspaces.has(moved.workspaceId) && before.workspaces.has(agent.workspaceId)) {
      fail(`agent ${id} points at a missing workspace`);
    } else if (isListed(agent, before.workspaces) !== isListed(moved, after.workspaces)) {
      fail(`agent ${id} changed visibility`);
    }
  }
  const listedBefore = listedRootIds(before);
  const listedAfter = listedRootIds(after);
  if (listedBefore.join() !== listedAfter.join()) {
    fail(`listed chats went from ${listedBefore.length} to ${listedAfter.length}`);
  }
  for (const [workspaceId, roots] of rootsByWorkspace(after.agents)) {
    if (roots.length > 1 && after.workspaces.has(workspaceId)) {
      fail(`workspace ${workspaceId} still has ${roots.length} chats`);
    }
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

// A complete, consistent copy of the database as it is now. An existing copy is kept: it is from a
// start that was interrupted before the split committed, so it already holds the same data.
async function backUp(database: PimiDatabase): Promise<string> {
  const backupPath = `${database.path}${CHAT_SPLIT_BACKUP_SUFFIX}`;
  if (await exists(backupPath)) return backupPath;
  const tmp = `${backupPath}.tmp`;
  await rm(tmp, { force: true });
  database.db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  // Chat text is private to the user, like the database it was copied from.
  await chmod(tmp, 0o600);
  await rename(tmp, backupPath);
  return backupPath;
}

export async function splitMultiChatWorkspaces(options: {
  database: PimiDatabase;
  logger: Logger;
  /** Runs after workspace rows were rewritten, so a cache over them can be read again. */
  onSplit?: () => Promise<void>;
}): Promise<ChatSplitResult> {
  const { database } = options;
  const logger = options.logger.child({ module: "chat-split" });
  const idle: ChatSplitResult = {
    ran: false,
    workspacesSplit: 0,
    workspacesCreated: 0,
    agentsMoved: 0,
    backupPath: null,
  };
  const done = () =>
    database.db.prepare("SELECT 1 AS present FROM meta WHERE key = ?").get(META_KEY) !== undefined;
  const markDone = () =>
    database.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?)")
      .run(META_KEY, new Date().toISOString());
  if (done()) return idle;

  try {
    const pending = [...rootsByWorkspace(readSnapshot(database).agents).values()].some(
      (roots) => roots.length > 1,
    );
    if (!pending) {
      database.transaction(markDone);
      return { ...idle, ran: true };
    }
    const backupPath = await backUp(database);
    const result = database.transaction(() => {
      const before = readSnapshot(database);
      const counts = split(database, before, new Date().toISOString());
      const after = readSnapshot(database);
      verify(before, after, counts.workspacesCreated);
      markDone();
      return {
        ...counts,
        agents: before.totalAgents,
        openAgents: before.liveAgents,
        listedChats: listedRootIds(after).length,
        workspacesBefore: before.totalWorkspaces,
        workspacesAfter: after.totalWorkspaces,
      };
    });
    logger.info({ ...result, backupPath }, "Gave every chat its own workspace record");
    await options.onSplit?.();
    return {
      ran: true,
      workspacesSplit: result.workspacesSplit,
      workspacesCreated: result.workspacesCreated,
      agentsMoved: result.agentsMoved,
      backupPath,
    };
  } catch (error) {
    logger.error(
      { err: error },
      "Could not give every chat its own workspace record; nothing was changed and the next start tries again",
    );
    return idle;
  }
}
