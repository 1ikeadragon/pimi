export type UsageProvider = "claude" | "codex";

export interface UsageEventRow {
  ts: number;
  provider: UsageProvider;
  model: string | null;
  sessionId: string;
  subagentId: string | null;
  parentSessionId: string | null;
  cwd: string | null;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  total: number;
  costUsd: number | null;
  dedupeKey: string;
}

export interface UsageToolCallRow {
  callId: string;
  ts: number;
  provider: UsageProvider;
  name: string;
}

export interface UsageSink {
  event(row: UsageEventRow): void;
  toolCall(row: UsageToolCallRow): void;
}

// One parser instance reads one transcript file from a byte offset. `state` is what the next
// incremental read of the same file needs to continue (for example the current model).
export interface UsageLineParser {
  // A line is parsed only when it contains one of these. Transcripts carry multi-megabyte request
  // blobs; the filter keeps them from ever reaching JSON.parse.
  readonly needles: readonly Buffer[];
  handle(line: string, sink: UsageSink): void;
  state(): unknown;
}

export function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
