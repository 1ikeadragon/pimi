import type { UsageAgentTreeChat, UsageAggregate } from "@pimi/protocol/messages";
import { cacheShare } from "./format";

// Heuristics, not findings. Each fires from numbers the screen already shows and stays quiet below a
// minimum sample so a quiet day does not produce advice. Tune against real data.
export const INSIGHT_THRESHOLDS = {
  minTokens: 5_000_000,
  coldCacheWriteShare: 0.4,
  minCacheEvents: 10,
  oneChatShare: 0.3,
  subagentShare: 0.5,
  topChatsForSubagents: 5,
  reasoningShare: 0.6,
  minChats: 3,
} as const;

export type InsightId = "coldCache" | "oneChat" | "subagentHeavy" | "reasoningHeavy";

export interface Insight {
  id: InsightId;
  /** Share of the range's tokens the tip concerns; tips sort by it. */
  share: number;
  values: Record<string, string | number>;
}

export interface InsightInput {
  totals: UsageAggregate;
  chats: readonly UsageAgentTreeChat[];
  formatTokens: (value: number) => string;
  formatPercent: (fraction: number) => string;
}

function subagentTokens(chat: UsageAgentTreeChat): number {
  return chat.subagents.reduce((sum, subagent) => sum + subagent.usage.total, 0);
}

export function computeInsights(input: InsightInput): Insight[] {
  const { totals, chats, formatTokens, formatPercent } = input;
  const limits = INSIGHT_THRESHOLDS;
  if (totals.total < limits.minTokens) return [];
  const insights: Insight[] = [];

  const cachedInput = totals.cacheRead + totals.cacheWrite;
  if (cachedInput > 0 && totals.events >= limits.minCacheEvents && cacheShare(totals) !== null) {
    const writeShare = totals.cacheWrite / cachedInput;
    if (writeShare > limits.coldCacheWriteShare) {
      insights.push({
        id: "coldCache",
        share: totals.cacheWrite / totals.total,
        values: {
          percent: formatPercent(writeShare),
          writes: formatTokens(totals.cacheWrite),
          reads: formatTokens(totals.cacheRead),
        },
      });
    }
  }

  const top = chats[0];
  if (top && chats.length >= limits.minChats) {
    const share = top.usage.total / totals.total;
    if (share > limits.oneChatShare) {
      insights.push({ id: "oneChat", share, values: { percent: formatPercent(share) } });
    }
  }

  const biggest = chats.slice(0, limits.topChatsForSubagents);
  const biggestTotal = biggest.reduce((sum, chat) => sum + chat.usage.total, 0);
  const subagents = biggest.reduce((sum, chat) => sum + subagentTokens(chat), 0);
  if (biggestTotal > 0 && subagents / biggestTotal > limits.subagentShare) {
    insights.push({
      id: "subagentHeavy",
      share: subagents / totals.total,
      values: { percent: formatPercent(subagents / biggestTotal) },
    });
  }

  if (totals.output > 0 && totals.reasoning / totals.output > limits.reasoningShare) {
    insights.push({
      id: "reasoningHeavy",
      share: totals.reasoning / totals.total,
      values: { percent: formatPercent(totals.reasoning / totals.output) },
    });
  }
  return insights.sort((a, b) => b.share - a.share);
}
