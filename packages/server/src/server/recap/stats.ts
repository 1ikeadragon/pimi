import { PARENT_AGENT_ID_LABEL } from "@pimi/protocol/agent-labels";
import type { RecapStats } from "@pimi/protocol/recap";
import type { Task } from "@pimi/protocol/task/types";
import { parseStoredAgentRecord, type StoredAgentRecord } from "../agent/agent-storage.js";
import type { PimiDatabase } from "../db/pimi-db.js";
import type { ProjectLookup } from "../usage/aggregate.js";

export interface RecapRange {
  startMs: number;
  endMs: number;
  timezoneOffsetMinutes: number;
}

export interface RecapSources {
  pimiDatabase: PimiDatabase;
  timelineDatabase: PimiDatabase;
  // Commits buffered timeline rows so the read sees the current turn.
  flushTimeline: () => void;
  loadProjects: (cwds: Iterable<string | null>) => Promise<ProjectLookup>;
  listTasks: () => Promise<Task[]>;
}

/** What the narrative model reads about one chat. Never sent to clients. */
export interface RecapChatDigest {
  title: string | null;
  project: string | null;
  prompts: number;
  promptSamples: string[];
  planned: boolean;
  filesChanged: number;
  tools: string[];
}

export interface RecapDigest {
  chats: RecapChatDigest[];
  doneTasks: string[];
}

export interface RecapComputation {
  stats: RecapStats;
  digest: RecapDigest;
  // The model most prompts went to; the narrative's automatic model pick ends with it.
  topModel: { provider: string; model: string } | null;
}

interface RecapRow {
  ts: string;
  type: string;
  fields: string | null;
  change: string | null;
}

// json_extract with several paths returns one JSON array, so each row's JSON is parsed once in
// SQLite and only the few fields Recap reads cross into JS. Tool outputs never leave the database.
const ROWS_SQL = `
  SELECT r.ts AS ts, r.type AS type,
    CASE r.type
      WHEN 'user_message' THEN json_extract(r.json, '$.text')
      WHEN 'tool_call' THEN json_extract(r.json, '$.name', '$.status', '$.detail.type', '$.detail.filePath')
    END AS fields,
    CASE WHEN r.type = 'tool_call' AND json_extract(r.json, '$.detail.type') IN ('edit', 'write')
      THEN json_extract(r.json, '$.detail.unifiedDiff', '$.detail.oldString', '$.detail.newString', '$.detail.content')
    END AS change
  FROM timeline_rows r JOIN timeline_agents a ON a.key = r.agent_key
  WHERE a.agent_id = ? AND r.ts >= ? AND r.ts < ?
  ORDER BY r.seq`;

const PROMPT_SAMPLES_PER_CHAT = 3;
const PROMPT_SAMPLE_CHARS = 240;
const DIGEST_CHATS = 40;
const GO_TO_PROMPT_MAX_CHARS = 100;
const SHORTEST_PROMPT_MAX_CHARS = 80;
const TOP_LIST = 8;
const THANKS = /\b(thanks|thank you|thank u|thx|ty)\b/i;

interface Turn {
  start: number;
  end: number;
}

interface ChatTally {
  record: StoredAgentRecord;
  // Prompted by the user: not a subagent, background or internal chat.
  isUserChat: boolean;
  isSubagent: boolean;
  prompts: number;
  promptSamples: string[];
  planned: boolean;
  files: Set<string>;
  tools: Map<string, number>;
  turns: Turn[];
}

interface PromptTally {
  count: number;
  words: number;
  thanks: number;
  hours: number[];
  days: Map<string, number>;
  normalized: Map<string, { text: string; count: number }>;
  shortest: string | null;
}

interface ChangeTally {
  added: number;
  removed: number;
  files: Set<string>;
}

function toRecapRow(row: Record<string, unknown>): RecapRow {
  return {
    ts: String(row.ts),
    type: String(row.type),
    fields: asString(row.fields),
    change: asString(row.change),
  };
}

function parseArray(value: string | null): unknown[] {
  if (value === null) return [];
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? parsed : [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function countLines(text: string | null): number {
  if (!text) return 0;
  return text.split("\n").length;
}

function tallyChange(change: ChangeTally, detailType: string, values: unknown[]): void {
  const [unifiedDiff, oldString, newString, content] = values.map(asString);
  if (detailType === "write") {
    change.added += countLines(content);
    return;
  }
  if (unifiedDiff) {
    for (const line of unifiedDiff.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) change.added += 1;
      else if (line.startsWith("-") && !line.startsWith("---")) change.removed += 1;
    }
    return;
  }
  change.added += countLines(newString);
  change.removed += countLines(oldString);
}

function normalizePrompt(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/, "")
    .trim();
}

function tallyPrompt(prompts: PromptTally, text: string, at: number, offsetMs: number): void {
  prompts.count += 1;
  prompts.words += text.split(/\s+/).length;
  if (THANKS.test(text)) prompts.thanks += 1;
  const local = new Date(at + offsetMs);
  prompts.hours[local.getUTCHours()] += 1;
  const day = local.toISOString().slice(0, 10);
  prompts.days.set(day, (prompts.days.get(day) ?? 0) + 1);
  if (text.length <= GO_TO_PROMPT_MAX_CHARS) {
    const key = normalizePrompt(text);
    const seen = prompts.normalized.get(key);
    if (seen) seen.count += 1;
    else prompts.normalized.set(key, { text, count: 1 });
  }
  const hasWord = /[\p{L}\p{N}]/u.test(text);
  if (hasWord && (prompts.shortest === null || text.length < prompts.shortest.length)) {
    prompts.shortest = text.slice(0, SHORTEST_PROMPT_MAX_CHARS);
  }
}

function readChat(input: {
  sources: RecapSources;
  chat: ChatTally;
  fromIso: string;
  toIso: string;
  prompts: PromptTally;
  change: ChangeTally;
  offsetMs: number;
}): void {
  const { chat, prompts, change, offsetMs } = input;
  const rows = input.sources.timelineDatabase.db
    .prepare(ROWS_SQL)
    .all(chat.record.id, input.fromIso, input.toIso)
    .map(toRecapRow);
  let turn: Turn | null = null;
  for (const row of rows) {
    const at = Date.parse(row.ts);
    if (!Number.isFinite(at)) continue;
    if (row.type === "user_message") {
      turn = { start: at, end: at };
      chat.turns.push(turn);
      const text = (row.fields ?? "").trim();
      if (chat.isUserChat && text) {
        chat.prompts += 1;
        if (chat.promptSamples.length < PROMPT_SAMPLES_PER_CHAT) {
          chat.promptSamples.push(text.slice(0, PROMPT_SAMPLE_CHARS));
        }
        tallyPrompt(prompts, text, at, offsetMs);
      }
      continue;
    }
    // A turn already running when the period started begins at its first row inside it.
    if (turn === null) {
      turn = { start: at, end: at };
      chat.turns.push(turn);
    }
    turn.end = at;
    if (row.type !== "tool_call") continue;
    const [name, status, detailType, filePath] = parseArray(row.fields).map(asString);
    if (name) chat.tools.set(name, (chat.tools.get(name) ?? 0) + 1);
    if (detailType === "plan") chat.planned = true;
    const isChange = detailType === "edit" || detailType === "write";
    if (isChange && status === "completed" && row.change !== null) {
      tallyChange(change, detailType, parseArray(row.change));
      if (filePath) {
        change.files.add(filePath);
        chat.files.add(filePath);
      }
    }
  }
}

/** The most agents with a turn running at one moment. Ends sort before starts at the same time. */
function peakParallel(turns: readonly Turn[]): number {
  const edges: Array<[number, number]> = [];
  for (const turn of turns) {
    if (turn.end <= turn.start) continue;
    edges.push([turn.start, 1], [turn.end, -1]);
  }
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let running = 0;
  let peak = 0;
  for (const [, delta] of edges) {
    running += delta;
    peak = Math.max(peak, running);
  }
  return peak;
}

function unionMs(turns: readonly Turn[]): number {
  const sorted = turns.filter((turn) => turn.end > turn.start).sort((a, b) => a.start - b.start);
  let total = 0;
  let open: Turn | null = null;
  for (const turn of sorted) {
    if (open && turn.start <= open.end) {
      open.end = Math.max(open.end, turn.end);
      continue;
    }
    if (open) total += open.end - open.start;
    open = { ...turn };
  }
  if (open) total += open.end - open.start;
  return total;
}

function turnMs(turns: readonly Turn[]): number {
  return turns.reduce((sum, turn) => sum + (turn.end - turn.start), 0);
}

function topEntries(map: Map<string, number>, limit: number): Array<[string, number]> {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function goToPrompt(prompts: PromptTally): RecapStats["goToPrompt"] {
  let best: { text: string; count: number } | null = null;
  for (const entry of prompts.normalized.values()) {
    if (entry.count < 2) continue;
    if (!best || entry.count > best.count) best = entry;
  }
  return best ? { text: best.text, count: best.count } : null;
}

function busiestDay(prompts: PromptTally): RecapStats["busiestDay"] {
  const [top] = topEntries(prompts.days, 1);
  return top ? { day: top[0], prompts: top[1] } : null;
}

function peakHour(prompts: PromptTally): number | null {
  if (prompts.count === 0) return null;
  return prompts.hours.indexOf(Math.max(...prompts.hours));
}

function chatRef(record: StoredAgentRecord) {
  return {
    agentId: record.id,
    workspaceId: record.workspaceId ?? null,
    title: record.title ?? null,
  };
}

function modelOf(record: StoredAgentRecord): string {
  return record.runtimeInfo?.model ?? record.config?.model ?? "default";
}

function loadAgents(database: PimiDatabase, fromIso: string): StoredAgentRecord[] {
  // updated_at only moves forward, so an agent with a row in the period was updated after it began.
  const rows = database.db
    .prepare("SELECT json FROM agents WHERE updated_at >= ? AND internal = 0")
    .all(fromIso);
  return rows.map((row) => parseStoredAgentRecord(JSON.parse(String(row.json))));
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function computeRecap(
  sources: RecapSources,
  range: RecapRange,
): Promise<RecapComputation> {
  const fromIso = new Date(range.startMs).toISOString();
  const toIso = new Date(range.endMs).toISOString();
  const offsetMs = range.timezoneOffsetMinutes * 60_000;
  sources.flushTimeline();

  const prompts: PromptTally = {
    count: 0,
    words: 0,
    thanks: 0,
    hours: Array.from({ length: 24 }, () => 0),
    days: new Map(),
    normalized: new Map(),
    shortest: null,
  };
  const change: ChangeTally = { added: 0, removed: 0, files: new Set() };
  const chats: ChatTally[] = [];
  for (const record of loadAgents(sources.pimiDatabase, fromIso)) {
    const isSubagent = Boolean(record.labels[PARENT_AGENT_ID_LABEL]);
    const chat: ChatTally = {
      record,
      isUserChat: !isSubagent && record.background !== true,
      isSubagent,
      prompts: 0,
      promptSamples: [],
      // Claude Code and Codex emit a plan item; OpenCode has no plan item, so a chat launched in
      // the read-only "plan" mode counts as planned for every provider.
      planned: record.config?.modeId === "plan",
      files: new Set(),
      tools: new Map(),
      turns: [],
    };
    readChat({ sources, chat, fromIso, toIso, prompts, change, offsetMs });
    if (chat.turns.length > 0) chats.push(chat);
    // One agent's rows are one synchronous read; yield so a long period never stalls the daemon.
    await yieldToEventLoop();
  }

  const userChats = chats.filter((chat) => chat.isUserChat && chat.prompts > 0);
  const allTurns = chats.flatMap((chat) => chat.turns);
  const projects = await sources.loadProjects(userChats.map((chat) => chat.record.cwd));
  const projectOf = (chat: ChatTally) => projects.resolve(chat.record.cwd)?.label ?? null;

  let longestRun: RecapStats["longestRun"] = null;
  for (const chat of chats) {
    for (const turn of chat.turns) {
      const ms = turn.end - turn.start;
      if (ms > 0 && (!longestRun || ms > longestRun.ms)) {
        longestRun = { ...chatRef(chat.record), ms };
      }
    }
  }

  const models = new Map<string, { provider: string; model: string; prompts: number }>();
  const projectTally = new Map<string, { project: string; chats: number; prompts: number }>();
  for (const chat of userChats) {
    const model = modelOf(chat.record);
    const modelKey = `${chat.record.provider}\u0000${model}`;
    const modelEntry = models.get(modelKey) ?? {
      provider: chat.record.provider,
      model,
      prompts: 0,
    };
    modelEntry.prompts += chat.prompts;
    models.set(modelKey, modelEntry);
    const project = projectOf(chat);
    if (project) {
      const entry = projectTally.get(project) ?? { project, chats: 0, prompts: 0 };
      entry.chats += 1;
      entry.prompts += chat.prompts;
      projectTally.set(project, entry);
    }
  }
  const modelList = [...models.values()].sort((a, b) => b.prompts - a.prompts);

  const tools = new Map<string, number>();
  for (const chat of chats) {
    for (const [name, calls] of chat.tools) tools.set(name, (tools.get(name) ?? 0) + calls);
  }

  const byPrompts = [...userChats].sort(
    (a, b) => b.prompts - a.prompts || turnMs(b.turns) - turnMs(a.turns),
  );
  const tasks = await sources.listTasks();
  const doneTasks = tasks.filter((task) => {
    if (task.status !== "done" || !task.completedAt) return false;
    const at = Date.parse(task.completedAt);
    return at >= range.startMs && at < range.endMs;
  });

  const stats: RecapStats = {
    prompts: prompts.count,
    chats: userChats.length,
    agents: chats.length,
    subagents: chats.filter((chat) => chat.isSubagent).length,
    peakParallel: peakParallel(allTurns),
    longestRun,
    agentMs: turnMs(allTurns),
    activeMs: unionMs(allTurns),
    linesAdded: change.added,
    linesRemoved: change.removed,
    filesChanged: change.files.size,
    plannedChats: userChats.filter((chat) => chat.planned).length,
    peakHour: peakHour(prompts),
    busiestDay: busiestDay(prompts),
    goToPrompt: goToPrompt(prompts),
    shortestPrompt: prompts.shortest,
    thanks: prompts.thanks,
    avgPromptWords: prompts.count > 0 ? prompts.words / prompts.count : null,
    models: modelList.slice(0, TOP_LIST),
    tools: topEntries(tools, TOP_LIST).map(([name, calls]) => ({ name, calls })),
    projects: [...projectTally.values()].sort((a, b) => b.prompts - a.prompts).slice(0, TOP_LIST),
    topChats: byPrompts.slice(0, TOP_LIST).map((chat) => ({
      agentId: chat.record.id,
      workspaceId: chat.record.workspaceId ?? null,
      title: chat.record.title ?? null,
      project: projectOf(chat),
      prompts: chat.prompts,
      agentMs: turnMs(chat.turns),
    })),
    doneTasks: doneTasks.length,
  };
  const digest: RecapDigest = {
    chats: byPrompts.slice(0, DIGEST_CHATS).map((chat) => ({
      title: chat.record.title ?? null,
      project: projectOf(chat),
      prompts: chat.prompts,
      promptSamples: chat.promptSamples,
      planned: chat.planned,
      filesChanged: chat.files.size,
      tools: topEntries(chat.tools, 5).map(([name]) => name),
    })),
    doneTasks: doneTasks.map((task) => task.title),
  };
  const top = modelList[0];
  return {
    stats,
    digest,
    topModel: top ? { provider: top.provider, model: top.model } : null,
  };
}
