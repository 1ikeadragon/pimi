import { basename } from "node:path";
import { requestCostUsd, type UsageSpeed } from "../prices.js";
import {
  isRecord,
  parseTimestamp,
  toNumber,
  type UsageEventRow,
  type UsageLineParser,
  type UsageSink,
} from "../types.js";

interface Counters {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  total: number;
}

interface CodexState {
  // The thread this file belongs to: the first session_meta. A forked thread's file also embeds the
  // fork source's session_meta after its own; that one is ignored.
  sessionId: string | null;
  parentSessionId: string | null;
  forked: boolean;
  cwd: string | null;
  model: string | null;
  speed: UsageSpeed;
  // Running totals of the thread after the last event counted, `total_token_usage` as Codex
  // reports it. Persisted so an incremental read continues from them.
  previous: Counters | null;
  // Counts the times the counter started over, so equal totals of different segments stay apart.
  segment: number;
}

function parentThreadId(source: unknown): string | null {
  if (!isRecord(source) || !isRecord(source.subagent)) return null;
  const spawn = source.subagent.thread_spawn;
  return isRecord(spawn) && typeof spawn.parent_thread_id === "string"
    ? spawn.parent_thread_id
    : null;
}

function countersOf(value: unknown): Counters | null {
  if (!isRecord(value)) return null;
  return {
    input: toNumber(value.input_tokens),
    cached: toNumber(value.cached_input_tokens),
    cacheWrite: toNumber(value.cache_write_input_tokens),
    output: toNumber(value.output_tokens),
    reasoning: toNumber(value.reasoning_output_tokens),
    total: toNumber(value.total_tokens),
  };
}

function speedOf(tier: unknown): UsageSpeed {
  if (tier === "priority" || tier === "fast") return "fast";
  if (tier === "ultrafast") return "ultrafast";
  return "standard";
}

// Codex rollouts record `token_count` events. `total_token_usage` is the thread's cumulative
// billed usage; `last_token_usage` is one request but is also repeated, or replaced by a context
// size estimate, on events that bill nothing (after a compaction the event carries only
// `total_tokens` and the cumulative counters do not move). A thread's own `tokens_used` in
// Codex's state database equals the final cumulative total, so the cumulative counters are the
// source of truth: an event counts the growth of the cumulative total since the previous counted
// event, and an event that does not grow it counts nothing. A counter that drops starts a new segment of the
// same file and counts from zero. The first event of a file counts from
// zero, which also recovers requests Codex never logged an event for.
//
// `input_tokens` includes cached input and cache writes, and `output_tokens` includes reasoning
// (`last_usage_includes_reasoning`), so uncached input is derived and reasoning is not added again.
// A forked thread starts a fresh counter (checked against real rollouts), so no replay filter is
// needed. Codex also writes continuation rollouts named `<thread>_<continuation>` that carry the
// thread's id in `session_meta` but run their own counter from zero, so the dedupe key is the
// rollout file's name (the same name with or without `.zst` is one rollout) plus the cumulative
// total, not the thread id.
export function createCodexParser(path: string, initial: unknown): UsageLineParser {
  // Events seen before the file names a model (older rollouts name it after their first request)
  // wait here for it. A read that ends first emits them with no model.
  const pending: UsageEventRow[] = [];
  const fileId = basename(path).replace(/\.jsonl(\.zst)?$/, "");
  const state: CodexState = {
    sessionId: null,
    parentSessionId: null,
    forked: false,
    cwd: null,
    model: null,
    speed: "standard",
    previous: null,
    segment: 0,
    ...(isRecord(initial) ? (initial as Partial<CodexState>) : {}),
  };
  return {
    needles: [
      Buffer.from('"type":"session_meta"'),
      Buffer.from('"type":"turn_context"'),
      Buffer.from('"type":"thread_settings_applied"'),
      Buffer.from('"type":"token_count"'),
      Buffer.from('"type":"function_call"'),
      Buffer.from('"type":"custom_tool_call"'),
    ],
    state: () => state,
    handle(line: string, sink: UsageSink): void {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      if (!isRecord(parsed) || !isRecord(parsed.payload)) return;
      const payload = parsed.payload;
      if (parsed.type === "session_meta") {
        if (state.sessionId === null) applySessionMeta(state, payload);
        return;
      }
      if (parsed.type === "turn_context") {
        if (typeof payload.model === "string") state.model = payload.model;
        if (typeof payload.cwd === "string") state.cwd = payload.cwd;
        flushPending(pending, state.model, sink);
        return;
      }
      const ts = parseTimestamp(parsed.timestamp);
      if (ts === null || state.sessionId === null) return;
      if (parsed.type === "response_item") {
        emitToolCall(payload, ts, sink);
      } else if (parsed.type === "event_msg" && payload.type === "thread_settings_applied") {
        applyThreadSettings(state, payload);
        flushPending(pending, state.model, sink);
      } else if (parsed.type === "event_msg" && payload.type === "token_count") {
        const event = buildEvent(state, fileId, payload, ts);
        if (!event) return;
        if (event.model === null) pending.push(event);
        else sink.event(event);
      }
    },
    finish(sink: UsageSink): void {
      flushPending(pending, null, sink);
    },
  };
}

function flushPending(pending: UsageEventRow[], model: string | null, sink: UsageSink): void {
  if (pending.length === 0) return;
  for (const row of pending.splice(0)) {
    row.model = model;
    row.costUsd = requestCostUsd({
      provider: "codex",
      model,
      input: row.input,
      cacheRead: row.cacheRead,
      cacheWrite: row.cacheWrite,
      cacheWrite1h: 0,
      output: row.output,
      speed: row.speed,
      usGeo: false,
    });
    sink.event(row);
  }
}

function applySessionMeta(state: CodexState, payload: Record<string, unknown>): void {
  if (typeof payload.id === "string") state.sessionId = payload.id;
  if (typeof payload.cwd === "string") state.cwd = payload.cwd;
  state.parentSessionId = parentThreadId(payload.source);
  state.forked = typeof payload.forked_from_id === "string";
}

function applyThreadSettings(state: CodexState, payload: Record<string, unknown>): void {
  const settings = payload.thread_settings;
  if (!isRecord(settings)) return;
  if (typeof settings.model === "string") state.model = settings.model;
  if ("service_tier" in settings) state.speed = speedOf(settings.service_tier);
}

function emitToolCall(payload: Record<string, unknown>, ts: number, sink: UsageSink): void {
  if (payload.type !== "function_call" && payload.type !== "custom_tool_call") return;
  const callId = typeof payload.call_id === "string" ? payload.call_id : null;
  const name = typeof payload.name === "string" ? payload.name : null;
  if (callId && name) sink.toolCall({ callId, ts, provider: "codex", name });
}

function buildEvent(
  state: CodexState,
  fileId: string,
  payload: Record<string, unknown>,
  ts: number,
): UsageEventRow | null {
  const info = payload.info;
  if (!isRecord(info) || state.sessionId === null) return null;
  const cumulative = countersOf(info.total_token_usage);
  if (cumulative === null) return null;
  // A counter that moves backwards started over (a resumed thread inside one rollout file), so
  // what it reports now is all new usage.
  const last = countersOf(info.last_token_usage);
  // The first event of a file can open with a counter that already holds usage from before the
  // file: a fork starts from its parent's totals (its first event replays the parent's last
  // request) and a continuation file starts from the thread's totals so far. Those tokens were
  // billed in the file they came from, so only the growth after this point is new. A continuation
  // keeps the request this event reports; a fork's first event is the parent's request, so it
  // keeps nothing.
  if (state.previous === null && last !== null && cumulative.total > last.total) {
    state.previous = cumulative;
    return state.forked ? null : eventFrom({ state, fileId, ts, counters: last });
  }
  const restarted = state.previous !== null && cumulative.total < state.previous.total;
  if (restarted) state.segment += 1;
  const previous =
    state.previous && !restarted
      ? state.previous
      : { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
  if (cumulative.total === previous.total) return null;
  state.previous = cumulative;
  const grown = (now: number, before: number): number => Math.max(0, now - before);
  return eventFrom({
    state,
    fileId,
    ts,
    counters: {
      input: grown(cumulative.input, previous.input),
      cached: grown(cumulative.cached, previous.cached),
      cacheWrite: grown(cumulative.cacheWrite, previous.cacheWrite),
      output: grown(cumulative.output, previous.output),
      reasoning: grown(cumulative.reasoning, previous.reasoning),
      total: 0,
    },
  });
}

function eventFrom(input: {
  state: CodexState;
  fileId: string;
  ts: number;
  counters: Counters;
}): UsageEventRow | null {
  const { state, fileId, ts, counters } = input;
  if (state.sessionId === null) return null;
  const cumulativeTotal = state.previous?.total ?? 0;
  const inputAll = counters.input;
  const cached = Math.min(inputAll, counters.cached);
  const cacheWrite = Math.min(inputAll - cached, counters.cacheWrite);
  const uncached = inputAll - cached - cacheWrite;
  const output = counters.output;
  const total = uncached + cached + cacheWrite + output;
  if (total === 0) return null;
  return {
    ts,
    provider: "codex",
    model: state.model,
    sessionId: state.sessionId,
    subagentId: null,
    parentSessionId: state.parentSessionId,
    cwd: state.cwd,
    input: uncached,
    cacheRead: cached,
    cacheWrite,
    cacheWrite1h: 0,
    output,
    reasoning: Math.min(output, counters.reasoning),
    total,
    speed: state.speed,
    usGeo: false,
    costUsd: requestCostUsd({
      provider: "codex",
      model: state.model,
      input: uncached,
      cacheRead: cached,
      cacheWrite,
      cacheWrite1h: 0,
      output,
      speed: state.speed,
      usGeo: false,
    }),
    dedupeKey: `codex:${fileId}:${state.segment}:${cumulativeTotal}`,
  };
}
