import { readFile, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type {
  UsageAgentTreeChat,
  UsageAgentTreeSubagent,
  UsageAggregate,
  UsageBreakdownRow,
  UsageGroupBy,
  UsageRange,
} from "@pimi/protocol/messages";
import { PARENT_AGENT_ID_LABEL } from "@pimi/protocol/agent-labels";
import type { PimiDatabase } from "../db/pimi-db.js";
import { PRICES_AS_OF } from "./prices.js";

const DAY_MS = 86_400_000;
const MAX_CHATS = 50;
const MAX_TOOL_ROWS = 25;

interface Bucket {
  provider: string;
  model: string | null;
  sessionId: string;
  subagentId: string | null;
  parentSessionId: string | null;
  cwd: string | null;
  bucket: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  total: number;
  pricedTokens: number;
  costUsd: number | null;
  events: number;
  firstTs: number;
  lastTs: number;
}

interface OwnerInfo {
  agentId: string;
  cwd: string;
  title: string | null;
  parentAgentId: string | null;
}

interface ProjectLookup {
  resolve(cwd: string | null): { key: string; label: string } | null;
}

interface Accumulator {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  total: number;
  pricedTokens: number;
  costUsd: number | null;
  events: number;
  chats: Set<string>;
}

function emptyAccumulator(): Accumulator {
  return {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    total: 0,
    pricedTokens: 0,
    costUsd: null,
    events: 0,
    chats: new Set(),
  };
}

function add(target: Accumulator, bucket: Bucket, chatKey: string): void {
  target.input += bucket.input;
  target.cacheRead += bucket.cacheRead;
  target.cacheWrite += bucket.cacheWrite;
  target.output += bucket.output;
  target.reasoning += bucket.reasoning;
  target.total += bucket.total;
  target.pricedTokens += bucket.pricedTokens;
  if (bucket.costUsd !== null) target.costUsd = (target.costUsd ?? 0) + bucket.costUsd;
  target.events += bucket.events;
  target.chats.add(chatKey);
}

function finish(accumulator: Accumulator): UsageAggregate {
  return {
    input: accumulator.input,
    cacheRead: accumulator.cacheRead,
    cacheWrite: accumulator.cacheWrite,
    output: accumulator.output,
    reasoning: accumulator.reasoning,
    total: accumulator.total,
    costUsd: accumulator.costUsd,
    pricedTokens: accumulator.pricedTokens,
    events: accumulator.events,
    chats: accumulator.chats.size,
  };
}

function chatKeyOf(bucket: Bucket): string {
  return `${bucket.provider}:${bucket.parentSessionId ?? bucket.sessionId}`;
}

export interface UsageQuery {
  range: UsageRange;
  provider: string | null;
  timezoneOffsetMinutes: number;
}

// Reads the usage ledger. Aggregation is SQL (`GROUP BY` per session, model and bucket); the
// per-chat, per-project and per-origin rollups run over those few thousand grouped rows, because
// chat ownership and project membership live in other tables and change after rows are written.
export class UsageReader {
  constructor(private readonly database: PimiDatabase) {}

  firstEventAt(): number | null {
    const row = this.database.db.prepare("SELECT MIN(ts) AS first FROM usage_events").get();
    return row && typeof row.first === "number" ? row.first : null;
  }

  today(timezoneOffsetMinutes: number): UsageAggregate {
    const rows = this.buckets({ range: "today", provider: null, timezoneOffsetMinutes }, "none");
    const accumulator = emptyAccumulator();
    for (const bucket of rows) add(accumulator, bucket, chatKeyOf(bucket));
    return finish(accumulator);
  }

  lastDays(
    timezoneOffsetMinutes: number,
    count: number,
  ): { day: string; total: number; costUsd: number | null }[] {
    const rows = this.buckets({ range: "week", provider: null, timezoneOffsetMinutes }, "day");
    const byDay = new Map<string, { total: number; costUsd: number | null }>();
    for (const bucket of rows) {
      const entry = byDay.get(bucket.bucket) ?? { total: 0, costUsd: null };
      entry.total += bucket.total;
      if (bucket.costUsd !== null) entry.costUsd = (entry.costUsd ?? 0) + bucket.costUsd;
      byDay.set(bucket.bucket, entry);
    }
    const todayStart = rangeStart("today", timezoneOffsetMinutes);
    const out: { day: string; total: number; costUsd: number | null }[] = [];
    for (let i = count - 1; i >= 0; i -= 1) {
      const day = localDay(todayStart - i * DAY_MS, timezoneOffsetMinutes);
      out.push({ day, ...(byDay.get(day) ?? { total: 0, costUsd: null }) });
    }
    return out;
  }

  async breakdown(
    query: UsageQuery,
    groupBy: UsageGroupBy,
  ): Promise<{ totals: UsageAggregate; activeDays: number; rows: UsageBreakdownRow[] }> {
    const bucketKind = groupBy === "day" || groupBy === "hour" ? groupBy : "none";
    const rows = this.buckets(query, bucketKind);
    const owners = this.loadOwners();
    // A project's tokens are attributed per chat, by the same directory the chat list shows.
    const chatCwds = groupBy === "project" ? chatCwdsOf(rows, owners) : null;
    const projects = chatCwds ? await this.loadProjects(chatCwds.values()) : null;

    const totals = emptyAccumulator();
    const groups = new Map<string, { label: string; acc: Accumulator }>();
    for (const bucket of rows) {
      const chatKey = chatKeyOf(bucket);
      add(totals, bucket, chatKey);
      const group = groupOf(bucket, groupBy, owners, projects, chatCwds);
      if (group === null) continue;
      let entry = groups.get(group.key);
      if (!entry) {
        entry = { label: group.label, acc: emptyAccumulator() };
        groups.set(group.key, entry);
      }
      add(entry.acc, bucket, chatKey);
    }
    const activeDays = groupBy === "day" ? groups.size : this.countActiveDays(query);

    const result =
      groupBy === "tool"
        ? this.toolRows(query)
        : sortRows(
            [...groups.entries()].map(([key, { label, acc }]) => ({
              key,
              label,
              usage: finish(acc),
            })),
            groupBy,
          );
    return { totals: finish(totals), activeDays, rows: result };
  }

  async agentTree(query: UsageQuery): Promise<UsageAgentTreeChat[]> {
    const chats = collectChats(this.buckets(query, "none"));
    const owners = this.loadOwners();
    const chatCwds = new Map<string, string | null>();
    for (const [key, chat] of chats) chatCwds.set(key, chatCwd(chat, owners.get(key) ?? null));
    const projects = await this.loadProjects(chatCwds.values());
    const built = new Map<string, UsageAgentTreeChat>();
    for (const [key, chat] of chats) {
      const owner = owners.get(key) ?? null;
      const cwd = chatCwds.get(key) ?? null;
      const subagents: UsageAgentTreeSubagent[] = [...chat.children.entries()].map(
        ([id, child]) => ({
          id,
          kind: "provider",
          agentId: null,
          title: null,
          usage: finish(child),
        }),
      );
      built.set(key, {
        id: key,
        provider: chat.provider,
        agentId: owner?.agentId ?? null,
        title: owner?.title ?? null,
        cwd,
        project: projects.resolve(cwd)?.label ?? null,
        outsidePimi: owner === null,
        lastActiveAt: chat.lastTs,
        usage: finish(chat.own),
        subagents,
      });
    }
    const folded = foldPimiSubagents(built, owners);
    for (const chat of built.values()) chat.subagents.sort((a, b) => b.usage.total - a.usage.total);
    return [...built.entries()]
      .filter(([key]) => !folded.has(key))
      .map(([, chat]) => chat)
      .sort((a, b) => b.usage.total - a.usage.total)
      .slice(0, MAX_CHATS);
  }

  private buckets(query: UsageQuery, bucket: "none" | "day" | "hour"): Bucket[] {
    const offsetMs = query.timezoneOffsetMinutes * 60_000;
    const bucketExpression = BUCKET_SQL[bucket];
    const params: (string | number)[] = [];
    if (bucket !== "none") params.push(offsetMs);
    params.push(rangeStart(query.range, query.timezoneOffsetMinutes));
    const providerClause = query.provider === null ? "" : "AND provider = ?";
    if (query.provider !== null) params.push(query.provider);
    const rows = this.database.db
      .prepare(
        `SELECT provider, model, session_id, subagent_id, parent_session_id, cwd,
           ${bucketExpression} AS bucket,
           SUM(input) AS input, SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write,
           SUM(output) AS output, SUM(reasoning) AS reasoning, SUM(total) AS total,
           SUM(CASE WHEN cost_usd IS NOT NULL THEN total ELSE 0 END) AS priced,
           SUM(cost_usd) AS cost, COUNT(*) AS events, MIN(ts) AS first_ts, MAX(ts) AS last_ts
         FROM usage_events WHERE ts >= ? ${providerClause}
         GROUP BY provider, model, session_id, subagent_id, parent_session_id, cwd, bucket`,
      )
      .all(...params);
    return rows.map((row) => ({
      provider: String(row.provider),
      model: row.model === null ? null : String(row.model),
      sessionId: String(row.session_id),
      subagentId: row.subagent_id === null ? null : String(row.subagent_id),
      parentSessionId: row.parent_session_id === null ? null : String(row.parent_session_id),
      cwd: row.cwd === null ? null : String(row.cwd),
      bucket: String(row.bucket),
      input: Number(row.input),
      cacheRead: Number(row.cache_read),
      cacheWrite: Number(row.cache_write),
      output: Number(row.output),
      reasoning: Number(row.reasoning),
      total: Number(row.total),
      pricedTokens: Number(row.priced),
      costUsd: row.cost === null ? null : Number(row.cost),
      events: Number(row.events),
      firstTs: Number(row.first_ts),
      lastTs: Number(row.last_ts),
    }));
  }

  private countActiveDays(query: UsageQuery): number {
    const params: (string | number)[] = [
      query.timezoneOffsetMinutes * 60_000,
      rangeStart(query.range, query.timezoneOffsetMinutes),
    ];
    if (query.provider !== null) params.push(query.provider);
    const row = this.database.db
      .prepare(
        `SELECT COUNT(DISTINCT strftime('%Y-%m-%d', (ts + ?) / 1000, 'unixepoch')) AS days
         FROM usage_events WHERE ts >= ? ${query.provider === null ? "" : "AND provider = ?"}`,
      )
      .get(...params);
    return Number(row?.days ?? 0);
  }

  private toolRows(query: UsageQuery): UsageBreakdownRow[] {
    const params: (string | number)[] = [rangeStart(query.range, query.timezoneOffsetMinutes)];
    if (query.provider !== null) params.push(query.provider);
    const rows = this.database.db
      .prepare(
        `SELECT name, COUNT(*) AS calls FROM usage_tool_calls
         WHERE ts >= ? ${query.provider === null ? "" : "AND provider = ?"}
         GROUP BY name ORDER BY calls DESC LIMIT ${MAX_TOOL_ROWS}`,
      )
      .all(...params);
    return rows.map((row) => ({
      key: String(row.name),
      label: String(row.name),
      usage: { ...finish(emptyAccumulator()), events: Number(row.calls) },
    }));
  }

  private loadOwners(): Map<string, OwnerInfo> {
    const owners = new Map<string, OwnerInfo>();
    const rows = this.database.db
      .prepare(
        `SELECT id, cwd, persistence_provider, provider_session_id,
           json_extract(json, '$.title') AS title,
           json_extract(json, '$.labels."${PARENT_AGENT_ID_LABEL}"') AS parent
         FROM agents WHERE provider_session_id IS NOT NULL AND persistence_provider IS NOT NULL`,
      )
      .all();
    for (const row of rows) {
      owners.set(`${String(row.persistence_provider)}:${String(row.provider_session_id)}`, {
        agentId: String(row.id),
        cwd: String(row.cwd),
        title: typeof row.title === "string" && row.title.trim() ? row.title : null,
        parentAgentId: typeof row.parent === "string" && row.parent ? row.parent : null,
      });
    }
    return owners;
  }

  private async loadProjects(cwds: Iterable<string | null>): Promise<ProjectLookup> {
    const projects = new Map<string, string>();
    const roots: { path: string; projectId: string }[] = [];
    const rows = this.database.db
      .prepare("SELECT kind, json FROM records WHERE kind IN ('project', 'workspace')")
      .all();
    for (const row of rows) {
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(String(row.json)) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof record.projectId !== "string") continue;
      if (row.kind === "project") {
        const label =
          (typeof record.customName === "string" && record.customName) ||
          (typeof record.displayName === "string" && record.displayName) ||
          null;
        if (label) projects.set(record.projectId, label);
        if (typeof record.rootPath === "string")
          roots.push({ path: record.rootPath, projectId: record.projectId });
      } else if (typeof record.cwd === "string") {
        roots.push({ path: record.cwd, projectId: record.projectId });
      }
    }
    roots.sort((a, b) => b.path.length - a.path.length);
    const rootPaths = new Set(roots.map((root) => root.path));
    const repoRoots = await findRepoRoots(cwds);
    const byRoot = (cwd: string) => {
      for (const root of roots) {
        if (cwd === root.path || cwd.startsWith(`${root.path}/`)) return root;
      }
      return null;
    };
    return {
      resolve(cwd) {
        if (!cwd) return null;
        const match = byRoot(cwd);
        // A folder project (for example ~) claims everything beneath it. Prefer the git repository
        // the directory actually sits in, so ~/Research/Pimi/packages/app counts as Pimi.
        const repo = repoRoots.get(cwd) ?? null;
        if (repo !== null && (match === null || repo.length > match.path.length)) {
          const registered = rootPaths.has(repo) ? byRoot(repo) : null;
          const label = registered ? projects.get(registered.projectId) : undefined;
          if (registered && label) return { key: registered.projectId, label };
          return { key: `dir:${repo}`, label: basename(repo) || repo };
        }
        if (match) {
          const label = projects.get(match.projectId);
          if (label) return { key: match.projectId, label };
        }
        return { key: `dir:${cwd}`, label: basename(cwd) || cwd };
      },
    };
  }
}

// The git repository each directory sits in, found by walking up to a `.git`. A linked worktree's
// `.git` is a file pointing into the main repository, so it resolves to the main checkout. Ancestor
// lookups are shared between directories, so each directory is stat-ed once.
async function findRepoRoots(cwds: Iterable<string | null>): Promise<Map<string, string | null>> {
  const byDir = new Map<string, string | null>();
  const find = async (dir: string): Promise<string | null> => {
    const known = byDir.get(dir);
    if (known !== undefined) return known;
    let found: string | null = null;
    const gitPath = `${dir}/.git`;
    const info = await stat(gitPath).catch(() => null);
    if (info) {
      found = dir;
      if (info.isFile()) {
        const text = await readFile(gitPath, "utf8").catch(() => "");
        const gitDir = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim();
        const at = gitDir?.indexOf("/.git/worktrees/") ?? -1;
        if (gitDir && at > 0) found = gitDir.slice(0, at);
      }
    } else {
      const parent = dirname(dir);
      found = parent === dir ? null : await find(parent);
    }
    byDir.set(dir, found);
    return found;
  };
  for (const cwd of new Set(cwds)) if (cwd) await find(cwd);
  return byDir;
}

interface ChatBuild {
  provider: string;
  cwdTokens: CwdTokens;
  lastTs: number;
  own: Accumulator;
  children: Map<string, Accumulator>;
}

interface CwdTally {
  total: number;
  firstTs: number;
}

// A transcript records the agent's cwd per message, so one chat can touch dozens of directories.
// Parent-session directories are tallied apart from subagent ones; the parent's own directories win.
interface CwdTokens {
  parent: Map<string, CwdTally>;
  subagent: Map<string, CwdTally>;
}

// The directory holding the most tokens; a tie goes to the one the chat visited first.
function dominantCwd(tokens: CwdTokens): string | null {
  const tally = tokens.parent.size > 0 ? tokens.parent : tokens.subagent;
  let best: { cwd: string; tally: CwdTally } | null = null;
  for (const [cwd, entry] of tally) {
    if (
      best === null ||
      entry.total > best.tally.total ||
      (entry.total === best.tally.total && entry.firstTs < best.tally.firstTs)
    ) {
      best = { cwd, tally: entry };
    }
  }
  return best?.cwd ?? null;
}

function collectChats(rows: Bucket[]): Map<string, ChatBuild> {
  const chats = new Map<string, ChatBuild>();
  for (const bucket of rows) {
    const key = chatKeyOf(bucket);
    let chat = chats.get(key);
    if (!chat) {
      chat = {
        provider: bucket.provider,
        cwdTokens: { parent: new Map(), subagent: new Map() },
        lastTs: 0,
        own: emptyAccumulator(),
        children: new Map(),
      };
      chats.set(key, chat);
    }
    chat.lastTs = Math.max(chat.lastTs, bucket.lastTs);
    if (bucket.cwd !== null) {
      const byCwd =
        bucket.parentSessionId === null ? chat.cwdTokens.parent : chat.cwdTokens.subagent;
      const seen = byCwd.get(bucket.cwd);
      if (seen) {
        seen.total += bucket.total;
        seen.firstTs = Math.min(seen.firstTs, bucket.firstTs);
      } else {
        byCwd.set(bucket.cwd, { total: bucket.total, firstTs: bucket.firstTs });
      }
    }
    add(chat.own, bucket, key);
    if (bucket.parentSessionId !== null) {
      const childId = bucket.subagentId ?? bucket.sessionId;
      let child = chat.children.get(childId);
      if (!child) {
        child = emptyAccumulator();
        chat.children.set(childId, child);
      }
      add(child, bucket, key);
    }
  }
  return chats;
}

// The directory holding the chat's tokens. The owner agent's cwd is only where the chat was started,
// not where the work happened, so it is the fallback when the transcript carries no cwd at all.
function chatCwd(chat: ChatBuild, owner: OwnerInfo | null): string | null {
  return dominantCwd(chat.cwdTokens) ?? owner?.cwd ?? null;
}

function chatCwdsOf(rows: Bucket[], owners: Map<string, OwnerInfo>): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const [key, chat] of collectChats(rows))
    out.set(key, chatCwd(chat, owners.get(key) ?? null));
  return out;
}

// Pimi subagents are chats of their own, linked to the parent chat by label. Fold them under the
// parent so a parent's total covers its subagents. Returns the keys that were folded away.
function foldPimiSubagents(
  built: Map<string, UsageAgentTreeChat>,
  owners: Map<string, OwnerInfo>,
): Set<string> {
  const byAgentId = new Map<string, string>();
  for (const [key, chat] of built) if (chat.agentId) byAgentId.set(chat.agentId, key);
  const folded = new Set<string>();
  for (const [key, owner] of owners) {
    const child = built.get(key);
    const parentKey = owner.parentAgentId ? byAgentId.get(owner.parentAgentId) : undefined;
    const parent = parentKey ? built.get(parentKey) : undefined;
    if (!child || !parent || parentKey === key) continue;
    parent.subagents.push({
      id: child.agentId ?? key,
      kind: "pimi",
      agentId: child.agentId,
      title: child.title,
      usage: child.usage,
    });
    parent.usage = mergeAggregates(parent.usage, child.usage);
    parent.lastActiveAt = Math.max(parent.lastActiveAt, child.lastActiveAt);
    folded.add(key);
  }
  return folded;
}

const BUCKET_SQL = {
  none: "''",
  day: "strftime('%Y-%m-%d', (ts + ?) / 1000, 'unixepoch')",
  hour: "strftime('%H', (ts + ?) / 1000, 'unixepoch')",
} as const;

function sortRows(rows: UsageBreakdownRow[], groupBy: UsageGroupBy): UsageBreakdownRow[] {
  if (groupBy === "day" || groupBy === "hour") {
    return rows.sort((a, b) => a.key.localeCompare(b.key));
  }
  return rows.sort((a, b) => b.usage.total - a.usage.total);
}

function mergeAggregates(a: UsageAggregate, b: UsageAggregate): UsageAggregate {
  return {
    input: a.input + b.input,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    total: a.total + b.total,
    costUsd: a.costUsd === null && b.costUsd === null ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0),
    pricedTokens: a.pricedTokens + b.pricedTokens,
    events: a.events + b.events,
    chats: a.chats + b.chats,
  };
}

function groupOf(
  bucket: Bucket,
  groupBy: UsageGroupBy,
  owners: Map<string, OwnerInfo>,
  projects: ProjectLookup | null,
  chatCwds: Map<string, string | null> | null,
): { key: string; label: string } | null {
  switch (groupBy) {
    case "provider":
      return { key: bucket.provider, label: bucket.provider };
    case "model":
      return {
        key: bucket.model ?? "unknown",
        label: bucket.model ?? "unknown",
      };
    case "day":
    case "hour":
      return { key: bucket.bucket, label: bucket.bucket };
    case "origin": {
      const pimi = owners.has(chatKeyOf(bucket));
      return pimi ? { key: "pimi", label: "Pimi" } : { key: "outside", label: "Outside Pimi" };
    }
    case "project":
      return (
        projects?.resolve(chatCwds?.get(chatKeyOf(bucket)) ?? null) ?? {
          key: "unknown",
          label: "unknown",
        }
      );
    case "tool":
      return null;
  }
}

export function pricesAsOf(): string {
  return PRICES_AS_OF;
}

function rangeStart(range: UsageRange, timezoneOffsetMinutes: number): number {
  if (range === "all") return 0;
  const offsetMs = timezoneOffsetMinutes * 60_000;
  const localNow = Date.now() + offsetMs;
  const todayStart = Math.floor(localNow / DAY_MS) * DAY_MS - offsetMs;
  if (range === "today") return todayStart;
  return todayStart - (range === "week" ? 6 : 29) * DAY_MS;
}

function localDay(utcMs: number, timezoneOffsetMinutes: number): string {
  return new Date(utcMs + timezoneOffsetMinutes * 60_000).toISOString().slice(0, 10);
}
