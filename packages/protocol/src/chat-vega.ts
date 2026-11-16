import { z } from "zod";
import { parseBlockJson } from "./chat-json.js";

export const PIMI_VEGA_FENCE = "pimi-vega";

/**
 * Agent output is untrusted, and a chart spec is a program for the renderer: it can name data to
 * fetch and links to follow. Every rule here is enforced before a spec reaches Vega.
 */
/** Properties that make Vega load or link to something outside the spec. */
const EXTERNAL_KEYS: ReadonlySet<string> = new Set(["url", "href"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** How many rows a `sequence` generator makes, or null when that cannot be read from the spec. */
function sequenceRows(sequence: unknown): number | null {
  if (!isRecord(sequence)) return null;
  const { start, stop, step = 1 } = sequence;
  if (typeof start !== "number" || typeof stop !== "number" || typeof step !== "number") {
    return null;
  }
  const rows = Math.ceil((stop - start) / step);
  return Number.isFinite(rows) && rows >= 0 ? rows : null;
}

/** Inspect every spec property without recursion. Inline rows are data, not executable spec. */
function isSelfContained(spec: Record<string, unknown>): boolean {
  const pending: unknown[] = [spec];
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
      continue;
    }
    if (!isRecord(value)) continue;
    for (const [key, child] of Object.entries(value)) {
      if (EXTERNAL_KEYS.has(key.toLowerCase())) return false;
      if (key === "data" && isRecord(child) && "values" in child) {
        const { values: _values, ...source } = child;
        pending.push(source);
      } else if (key === "datasets" && isRecord(child)) {
        // Named datasets hold inline data; fields may legitimately be called url or href.
        continue;
      } else if (key === "sequence") {
        // Reject an unbounded generator, rather than replacing or truncating its output.
        if (sequenceRows(child) === null) return false;
      } else pending.push(child);
    }
  }
  return true;
}

const specSchema = z
  .record(z.string(), z.unknown())
  // Vega-Lite only. A raw Vega spec is a larger surface with its own loaders and expressions.
  .refine(({ $schema }) => typeof $schema !== "string" || !/\/vega\/v/i.test($schema))
  .refine(isSelfContained);

export interface ChatVega {
  /** The Vega-Lite spec, without its title. */
  spec: Record<string, unknown>;
  /** Shown as the card heading, where it can wrap; a title inside the chart is one clipped line. */
  title?: string;
  subtitle?: string;
}

function titleText(value: unknown): string | undefined {
  const text = Array.isArray(value) ? value.join(" ") : value;
  return typeof text === "string" && text.trim() ? text.trim() : undefined;
}

/** Returns null for anything that must not be handed to Vega; the caller then shows the source. */
export function parseChatVega(source: string): ChatVega | null {
  let data: unknown;
  try {
    data = parseBlockJson(source);
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
