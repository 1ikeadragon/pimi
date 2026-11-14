import { createHash } from "node:crypto";
import type { UsageProvider } from "./types.js";

// Bundled list prices for the API-equivalent cost of a request. Nothing is fetched at runtime: the
// daemon stays local and the table below is reviewed at release time. A model that is not listed
// has no cost (its tokens still count); there is no guessing, no fitting and no fallback rate.
//
// Sources, read 2026-11-14:
//   Claude    https://platform.claude.com/docs/en/about-claude/pricing
//   OpenAI    https://developers.openai.com/api/docs/pricing
//             https://developers.openai.com/api/docs/models/gpt-5.4-mini
//             https://developers.openai.com/api/docs/models/gpt-5.1-codex-mini
//
// Rules taken from those pages and applied per request (one transcript event):
//   - Claude bills cache writes by TTL: 5m = 1.25x input, 1h = 2x input. Cache reads are 0.1x
//     input (0.025x Fable 5.1/5.2, 0.05x Opus 5.5 and Sonnet 5.5). Claude 4.6 and later include the
//     1M window at standard rates; Haiku 5.5 charges its higher tier when the whole prompt
//     (input + cache reads + cache writes) is over 100k tokens.
//   - Fast mode (usage.speed "fast") is 2x every rate on the models that offer it. US-only inference
//     (usage.inference_geo "us") is 1.1x every rate on Claude 4.6 and later.
//   - OpenAI bills cached input at the cached rate and cache writes at the 30-minute write rate
//     (a transcript does not say which TTL was used). A prompt over 272K input tokens uses the
//     long-context rates for every token of that request. Fast (service tier "priority") is 2x, 2.5x
//     for gpt-5.5; ultrafast is 6x. OpenAI lists no long-context fast rates, so the multiplier is
//     applied to the long-context rates as well.
//   - Not billed per token and therefore not modelled: Batch/Flex discounts (transcripts do not
//     record them), web search and other server tool fees, regional processing uplifts on OpenAI.

export type UsageSpeed = "standard" | "fast" | "ultrafast";

// USD per million tokens.
interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

interface ModelPrice extends Rates {
  // Applies to a request whose prompt has more than `above` tokens.
  longContext?: { above: number; rates: Rates };
  fast?: number;
  ultrafast?: number;
  usGeoMultiplier?: number;
}

function claude(
  input: number,
  output: number,
  cacheRead: number,
  extra: Partial<ModelPrice> = {},
): ModelPrice {
  return {
    input,
    output,
    cacheRead,
    cacheWrite5m: input * 1.25,
    cacheWrite1h: input * 2,
    ...extra,
  };
}

function openai(
  input: number,
  cached: number,
  output: number,
  write30m: number | null = null,
  write12h: number | null = null,
  extra: Partial<ModelPrice> = {},
): ModelPrice {
  return {
    input,
    output,
    cacheRead: cached,
    cacheWrite5m: write30m ?? input,
    cacheWrite1h: write12h ?? input,
    fast: 2,
    ...extra,
  };
}

function openaiLong(
  input: number,
  cached: number,
  output: number,
  write30m: number | null,
  write12h: number | null,
): { above: number; rates: Rates } {
  return {
    above: 272_000,
    rates: {
      input,
      output,
      cacheRead: cached,
      cacheWrite5m: write30m ?? input,
      cacheWrite1h: write12h ?? input,
    },
  };
}

const US = 1.1;
const FAST = 2;

const FABLE_52 = claude(8, 40, 0.2, { fast: FAST, usGeoMultiplier: US });
const FABLE_5X = claude(10, 50, 0.25, { usGeoMultiplier: US });
const OPUS_45_TO_5 = claude(5, 25, 0.5, { usGeoMultiplier: US });
const OPUS_41 = claude(15, 75, 1.5);
const SONNET_4X = claude(3, 15, 0.3);

const PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-fable-5-2": FABLE_52,
  "claude-mythos-5-2": FABLE_52,
  "claude-fable-5-1": FABLE_5X,
  "claude-mythos-5-1": FABLE_5X,
  "claude-fable-5": claude(10, 50, 1, { usGeoMultiplier: US }),
  "claude-mythos-5": claude(10, 50, 1, { usGeoMultiplier: US }),
  "claude-opus-5-5": claude(4, 20, 0.2, { fast: FAST, usGeoMultiplier: US }),
  "claude-opus-5": { ...OPUS_45_TO_5, fast: FAST },
  "claude-opus-4-8": { ...OPUS_45_TO_5, fast: FAST },
  "claude-opus-4-7": OPUS_45_TO_5,
  "claude-opus-4-6": OPUS_45_TO_5,
  "claude-opus-4-5": { ...OPUS_45_TO_5, usGeoMultiplier: undefined },
  "claude-opus-4-1": OPUS_41,
  "claude-opus-4": OPUS_41,
  "claude-sonnet-5-5": claude(2, 10, 0.1, { usGeoMultiplier: US }),
  "claude-sonnet-5": claude(2, 10, 0.2, { usGeoMultiplier: US }),
  "claude-sonnet-4-6": claude(3, 15, 0.3, { usGeoMultiplier: US }),
  "claude-sonnet-4-5": SONNET_4X,
  "claude-sonnet-4": SONNET_4X,
  "claude-haiku-5-5": claude(0.1, 0.5, 0.01, {
    usGeoMultiplier: US,
    longContext: {
      above: 100_000,
      rates: {
        input: 0.5,
        output: 2.5,
        cacheRead: 0.05,
        cacheWrite5m: 0.625,
        cacheWrite1h: 1,
      },
    },
  }),
  "claude-haiku-4-5": claude(1, 5, 0.1),

  "gpt-6-astra": openai(10, 1, 50, 12.5, 25, {
    ultrafast: 6,
    longContext: openaiLong(20, 2, 75, 25, 50),
  }),
  "gpt-6-astra-law": openai(10, 1, 50, 12.5, 25),
  "gpt-6.1-sol": openai(2, 0.1, 10, 2.5, 5, {
    ultrafast: 6,
    longContext: openaiLong(4, 0.2, 15, 5, 10),
  }),
  "gpt-6.1-terra": openai(1, 0.05, 5, 1.25, 2.5, { longContext: openaiLong(2, 0.1, 7.5, 2.5, 5) }),
  "gpt-6-sol": openai(2, 0.2, 10, 2.5, 5, { longContext: openaiLong(4, 0.4, 15, 5, 10) }),
  "gpt-6-luna": openai(0.1, 0.01, 0.5, 0.125, 0.25, {
    longContext: openaiLong(0.2, 0.02, 0.75, 0.25, 0.5),
  }),
  "gpt-5.6-sol": openai(4, 0.4, 20, 5, 10, { longContext: openaiLong(8, 0.8, 30, 10, 20) }),
  "gpt-5.6-terra": openai(2, 0.2, 12, 2.5, 5, { longContext: openaiLong(4, 0.4, 18, 5, 10) }),
  "gpt-5.6-luna": openai(0.2, 0.02, 1.2, 0.25, 0.5, {
    longContext: openaiLong(0.4, 0.04, 1.8, 0.5, 1),
  }),
  "gpt-5.5": openai(5, 0.5, 30, null, null, {
    fast: 2.5,
    longContext: openaiLong(10, 1, 45, null, null),
  }),
  "gpt-5.4": openai(2.5, 0.25, 15, null, null, {
    longContext: openaiLong(5, 0.5, 22.5, null, null),
  }),
  "gpt-5.4-mini": openai(0.75, 0.075, 4.5),
  "gpt-5.3-codex": openai(1.75, 0.175, 14),
  "gpt-5.1-codex-mini": openai(0.25, 0.025, 2),
};

// Changes whenever any rate or rule above changes; the scanner reprices stored events when it
// differs from the version they were priced with.
export const PRICES_VERSION = createHash("sha256")
  .update(JSON.stringify(PRICES))
  .update("rules-2")
  .digest("hex")
  .slice(0, 16);

export function priceForModel(model: string | null): ModelPrice | null {
  if (model === null) return null;
  const normalized = model
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, "")
    .replace(/-\d{8}$/, "");
  return PRICES[normalized] ?? null;
}

// One provider request, in the ledger's split: `input` excludes cache reads and writes, and
// `cacheWrite1h` is the part of `cacheWrite` written with the one-hour TTL.
export interface PricedRequest {
  provider: UsageProvider;
  model: string | null;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  output: number;
  speed: UsageSpeed;
  usGeo: boolean;
}

export function requestCostUsd(request: PricedRequest): number | null {
  const price = priceForModel(request.model);
  if (price === null) return null;
  const prompt = request.input + request.cacheRead + request.cacheWrite;
  const rates =
    price.longContext && prompt > price.longContext.above ? price.longContext.rates : price;
  const oneHour = Math.min(request.cacheWrite1h, request.cacheWrite);
  const base =
    request.input * rates.input +
    request.cacheRead * rates.cacheRead +
    (request.cacheWrite - oneHour) * rates.cacheWrite5m +
    oneHour * rates.cacheWrite1h +
    request.output * rates.output;
  let multiplier = 1;
  if (request.speed === "fast") multiplier *= price.fast ?? 1;
  if (request.speed === "ultrafast") multiplier *= price.ultrafast ?? price.fast ?? 1;
  if (request.usGeo) multiplier *= price.usGeoMultiplier ?? 1;
  return (base * multiplier) / 1_000_000;
}
