import { z } from "zod";

export const PIMI_VEGA_FENCE = "pimi-vega";

/**
 * Vega runs in the app's own JavaScript, not in a sandbox, so a chart may not name data to fetch
 * or links to follow: those would be requests and navigation from the app itself.
 */
export const VEGA_LIMITS = {
  /** Bounds the work of re-parsing the block on every streamed token. */
  sourceLength: 1_048_576,
  /** A chart taller than this takes over the conversation. */
  height: 480,
} as const;

/** Properties that make Vega load or link to something outside the spec. */
const EXTERNAL_KEYS: ReadonlySet<string> = new Set(["url", "href"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Walks the whole spec once. Returns false on a `url` or `href` property at any depth, which
 * covers data sources, image marks, link channels, lookups and config. Inline rows are data, not
 * walked, because a column may be called `url`.
 */
function isSelfContained(spec: Record<string, unknown>): boolean {
  const pending: unknown[] = [spec];
  for (let value = pending.pop(); value !== undefined; value = pending.pop()) {
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (!isRecord(value)) continue;
    for (const [key, child] of Object.entries(value)) {
      if (EXTERNAL_KEYS.has(key.toLowerCase())) return false;
      if (key === "datasets") continue;
      if (key === "data" && isRecord(child) && "values" in child) {
        const { values: _values, ...source } = child;
        pending.push(source);
        continue;
      }
      pending.push(child);
    }
  }
  return true;
}

const specSchema = z.record(z.string(), z.unknown()).refine(isSelfContained);

export interface ChatVega {
  /** The Vega-Lite spec, without its title. */
  spec: Record<string, unknown>;
  /** Shown as the card heading, where it can wrap; a title inside the chart is one clipped line. */
  title?: string;
  subtitle?: string;
}

function titleText(value: unknown): string | undefined {
  const text = Array.isArray(value) ? value.join(" ") : value;
  return typeof text === "string" && text.trim() ? text.trim().slice(0, 240) : undefined;
}

/** Returns null for an invalid or over-long block, or one that names a URL or link; the caller then shows the source. */
export function parseChatVega(source: string): ChatVega | null {
  if (source.length > VEGA_LIMITS.sourceLength) return null;
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch {
    return null;
  }
  const result = specSchema.safeParse(data);
  if (!result.success) return null;
  const { title, ...spec } = result.data;
  if (isRecord(title)) {
    return { spec, title: titleText(title.text), subtitle: titleText(title.subtitle) };
  }
  return { spec, title: titleText(title) };
}
