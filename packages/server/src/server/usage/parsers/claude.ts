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

function emitToolCalls(message: Record<string, unknown>, ts: number, sink: UsageSink): void {
  if (!Array.isArray(message.content)) return;
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "tool_use") continue;
    const callId = typeof block.id === "string" ? block.id : null;
    const name = typeof block.name === "string" ? block.name : null;
    if (callId && name) sink.toolCall({ callId, ts, provider: "claude", name });
  }
}

function subagentIdOf(line: Record<string, unknown>, fileId: string | null): string | null {
  if (fileId === null) return null;
  return typeof line.agentId === "string" ? `agent-${line.agentId}` : fileId;
}

function buildEvent(
  line: Record<string, unknown>,
  message: Record<string, unknown>,
  usage: Record<string, unknown>,
  fileId: string | null,
): UsageEventRow | null {
  const ts = parseTimestamp(line.timestamp);
  const sessionId = typeof line.sessionId === "string" ? line.sessionId : null;
  const messageId = typeof message.id === "string" ? message.id : null;
  const key = messageId ?? (typeof line.uuid === "string" ? line.uuid : null);
  if (ts === null || sessionId === null || key === null) return null;
  const model = typeof message.model === "string" ? message.model : null;
  const input = toNumber(usage.input_tokens);
  const cacheRead = toNumber(usage.cache_read_input_tokens);
  const cacheWrite = toNumber(usage.cache_creation_input_tokens);
  const output = toNumber(usage.output_tokens);
  const total = input + cacheRead + cacheWrite + output;
  if (total === 0) return null;
  const cacheCreation = isRecord(usage.cache_creation) ? usage.cache_creation : null;
  const cacheWrite1h = cacheCreation
    ? Math.min(cacheWrite, toNumber(cacheCreation.ephemeral_1h_input_tokens))
    : 0;
  const speed: UsageSpeed = usage.speed === "fast" ? "fast" : "standard";
  const usGeo = usage.inference_geo === "us";
  const details = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : null;
  const subagentId = subagentIdOf(line, fileId);
  const requestId = typeof line.requestId === "string" ? line.requestId : "";
  return {
    ts,
    provider: "claude",
    model,
    sessionId,
    subagentId,
    parentSessionId: subagentId === null ? null : sessionId,
    cwd: typeof line.cwd === "string" ? line.cwd : null,
    input,
    cacheRead,
    cacheWrite,
    cacheWrite1h,
    output,
    reasoning: details ? toNumber(details.thinking_tokens) : 0,
    total,
    speed,
    usGeo,
    costUsd: requestCostUsd({
      provider: "claude",
      model,
      input,
      cacheRead,
      cacheWrite,
      cacheWrite1h,
      output,
      speed,
      usGeo,
    }),
    dedupeKey: `claude:${key}:${requestId}`,
  };
}

// Claude Code writes one JSONL line per content block of a response, and every line of one
// response repeats the same `message.usage`. The response is identified by message id plus
// request id; the store keeps one row per key (and the larger total if a streamed partial was
// written first). Subagent transcripts live in <session>/subagents/agent-*.jsonl and carry the
// parent's sessionId. Sidechain requests are separate API calls, so they are counted once here and
// never again in the parent.
export function createClaudeParser(path: string): UsageLineParser {
  const fileId = path.includes("/subagents/") ? basename(path, ".jsonl") : null;
  return {
    needles: [Buffer.from('"type":"assistant"')],
    state: () => null,
    handle(raw: string, sink: UsageSink): void {
      let line: unknown;
      try {
        line = JSON.parse(raw);
      } catch {
        return;
      }
      if (!isRecord(line) || line.type !== "assistant") return;
      const message = line.message;
      if (!isRecord(message) || !isRecord(message.usage) || message.model === "<synthetic>") return;
      const ts = parseTimestamp(line.timestamp);
      if (ts !== null) emitToolCalls(message, ts, sink);
      const event = buildEvent(line, message, message.usage, fileId);
      if (event) sink.event(event);
    },
  };
}
