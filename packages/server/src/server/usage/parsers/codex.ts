import { estimateCostUsd } from "../prices.js";
import {
  isRecord,
  parseTimestamp,
  toNumber,
  type UsageEventRow,
  type UsageLineParser,
  type UsageSink,
} from "../types.js";

interface CodexState {
  sessionId: string | null;
  parentSessionId: string | null;
  cwd: string | null;
  model: string | null;
}

function parentThreadId(source: unknown): string | null {
  if (!isRecord(source) || !isRecord(source.subagent)) return null;
  const spawn = source.subagent.thread_spawn;
  return isRecord(spawn) && typeof spawn.parent_thread_id === "string"
    ? spawn.parent_thread_id
    : null;
}

// Codex rollouts record `token_count` events whose `last_token_usage` is one request and whose
// `total_token_usage` is the running total of the thread. Events repeat when only rate limits
// change, so the key is the thread id plus both totals. `input_tokens` includes cached input and
// `output_tokens` includes reasoning, so uncached input is derived. Forked threads do not replay
// the parent's events (checked against real rollouts), so no fork special case is needed.
export function createCodexParser(initial: unknown): UsageLineParser {
  const state: CodexState = {
    sessionId: null,
    parentSessionId: null,
    cwd: null,
    model: null,
    ...(isRecord(initial) ? (initial as Partial<CodexState>) : {}),
  };
  return {
    needles: [
      Buffer.from('"type":"session_meta"'),
      Buffer.from('"type":"turn_context"'),
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
        applySessionMeta(state, payload);
        return;
      }
      if (parsed.type === "turn_context") {
        if (typeof payload.model === "string") state.model = payload.model;
        if (typeof payload.cwd === "string") state.cwd = payload.cwd;
        return;
      }
      const ts = parseTimestamp(parsed.timestamp);
      if (ts === null || state.sessionId === null) return;
      if (parsed.type === "response_item") {
        emitToolCall(payload, ts, sink);
      } else if (parsed.type === "event_msg" && payload.type === "token_count") {
        const event = buildEvent(state, payload, ts);
        if (event) sink.event(event);
      }
    },
  };
}

function applySessionMeta(state: CodexState, payload: Record<string, unknown>): void {
  if (typeof payload.id === "string") state.sessionId = payload.id;
  if (typeof payload.cwd === "string") state.cwd = payload.cwd;
  state.parentSessionId = parentThreadId(payload.source);
}

function emitToolCall(payload: Record<string, unknown>, ts: number, sink: UsageSink): void {
  if (payload.type !== "function_call" && payload.type !== "custom_tool_call") return;
  const callId = typeof payload.call_id === "string" ? payload.call_id : null;
  const name = typeof payload.name === "string" ? payload.name : null;
  if (callId && name) sink.toolCall({ callId, ts, provider: "codex", name });
}

function buildEvent(
  state: CodexState,
  payload: Record<string, unknown>,
  ts: number,
): UsageEventRow | null {
  const info = payload.info;
  if (!isRecord(info) || !isRecord(info.last_token_usage) || state.sessionId === null) return null;
  const last = info.last_token_usage;
  const totalUsage = isRecord(info.total_token_usage) ? info.total_token_usage : null;
  const cached = toNumber(last.cached_input_tokens);
  const input = Math.max(0, toNumber(last.input_tokens) - cached);
  const cacheWrite = toNumber(last.cache_write_input_tokens);
  const output = toNumber(last.output_tokens);
  const total = input + cached + cacheWrite + output;
  if (total === 0) return null;
  const runningTotal = totalUsage ? toNumber(totalUsage.total_tokens) : 0;
  return {
    ts,
    provider: "codex",
    model: state.model,
    sessionId: state.sessionId,
    subagentId: null,
    parentSessionId: state.parentSessionId,
    cwd: state.cwd,
    input,
    cacheRead: cached,
    cacheWrite,
    output,
    reasoning: toNumber(last.reasoning_output_tokens),
    total,
    costUsd: estimateCostUsd(state.model, { input, cacheRead: cached, cacheWrite, output }),
    dedupeKey: `codex:${state.sessionId}:${runningTotal}:${toNumber(last.total_tokens)}`,
  };
}
