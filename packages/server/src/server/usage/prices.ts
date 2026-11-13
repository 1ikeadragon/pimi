// Bundled price table for API-equivalent cost estimates. No network fetch: the daemon stays
// local. A model that is not listed has no cost, never a guess. Update at release time.
//
// Rates are USD per million tokens. `cacheWrite` is the rate Claude Code pays in practice, which
// is its one-hour cache tier (2x input) for the 4.x models.
export const PRICES_AS_OF = "2026-11-14";

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 2 },
  "claude-sonnet-4": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 6 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 6 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 6 },
  "claude-opus-4": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 30 },
  "claude-opus-4-1": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 30 },
  "claude-opus-4-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 },
  // The 5.5 rates below are fitted, not published: least squares of the session costs that Claude
  // Code itself records (`cost-state` lines) against the same sessions' token totals, 2026-11-14.
  // Replace them with published rates when available.
  "claude-haiku-5-5": { input: 0.15, output: 0.73, cacheRead: 0.02, cacheWrite: 0.13 },
  "claude-sonnet-5-5": { input: 2.1, output: 10.5, cacheRead: 0.07, cacheWrite: 4.07 },
  "claude-opus-5-5": { input: 5.2, output: 25.8, cacheRead: 0.14, cacheWrite: 8.1 },
};

export function priceForModel(model: string | null): ModelPrice | null {
  if (model === null) return null;
  const normalized = model.replace(/-\d{8}$/, "");
  return PRICES[normalized] ?? null;
}

export interface UsageCounters {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export function estimateCostUsd(model: string | null, counters: UsageCounters): number | null {
  const price = priceForModel(model);
  if (price === null) return null;
  return (
    (counters.input * price.input +
      counters.cacheRead * price.cacheRead +
      counters.cacheWrite * price.cacheWrite +
      counters.output * price.output) /
    1_000_000
  );
}
