import {
  MAX_AGENT_USAGE_SAMPLES,
  type AgentUsage,
  type AgentUsageCounters,
} from "@pimi/protocol/agent-types";

const counters = [
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "reportedTotalTokens",
  "totalCostUsd",
] as const satisfies readonly (keyof AgentUsageCounters)[];

export function withRecordedUsage(
  previous: AgentUsage | undefined,
  next: AgentUsage,
  report: AgentUsage,
): AgentUsage {
  const samples = previous?.recentSamples ?? [];
  const sample: AgentUsageCounters = {};
  for (const field of counters) {
    const value = report[field];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) sample[field] = value;
  }
  const last = samples.at(-1);
  const changed =
    Object.keys(sample).length > 0 && counters.some((field) => sample[field] !== last?.[field]);
  const recentSamples = changed
    ? [
        ...samples.slice(-(MAX_AGENT_USAGE_SAMPLES - 1)),
        { ...sample, capturedAt: new Date().toISOString() },
      ]
    : samples;
  return recentSamples.length ? { ...next, recentSamples } : next;
}
