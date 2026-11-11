import { z } from "zod";

export const PIMI_VEGA_FENCE = "pimi-vega";

/**
 * Agent output is untrusted, and a chart spec is a program for the renderer: it can name data to
 * fetch and links to follow. Every rule here is enforced before a spec reaches Vega.
 */
export const VEGA_LIMITS = {
  /** The whole block. A few hundred rows of a handful of fields fit with room to spare. */
  sourceLength: 65_536,
  /** Inline rows across every dataset in the spec. More than this is a file, not a chat block. */
  rows: 2_000,
  /** Bounds the walk below. Real specs nest about ten levels. */
  depth: 32,
  /** A chart taller than this takes over the conversation. */
  height: 480,
} as const;

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

function inlineRows(values: unknown): number {
  if (Array.isArray(values)) return values.length;
  // CSV or TSV text: one row per line.
  if (typeof values === "string") return values.split("\n").length;
  return 1;
}

/** What one property adds to the walk: rows it holds inline, and a value still to be walked. */
interface PropertyReading {
  rows: number;
  nested?: unknown;
}

/** Returns null for a property that makes the spec undrawable. */
function readProperty(key: string, child: unknown): PropertyReading | null {
  if (EXTERNAL_KEYS.has(key.toLowerCase())) return null;
  if (key === "data" && isRecord(child) && "values" in child) {
    // Inline rows are counted but not walked: they are data, and a column may be called `url`.
    const { values, ...source } = child;
    return { rows: inlineRows(values), nested: source };
  }
  if (key === "datasets" && isRecord(child)) {
    return { rows: Object.values(child).reduce<number>((sum, rows) => sum + inlineRows(rows), 0) };
  }
  if (key === "sequence") {
    const rows = sequenceRows(child);
    return rows === null ? null : { rows };
  }
  return { rows: 0, nested: child };
}

/**
 * Walks the whole spec once. It fails on a `url` or `href` property at any depth, which covers
 * data sources, image marks, link channels, lookups and config. Returns the inline row count, or
 * null for a spec that must not be drawn.
 */
function countRowsIfSelfContained(spec: Record<string, unknown>): number | null {
  let rows = 0;
  const pending: { value: unknown; depth: number }[] = [{ value: spec, depth: 1 }];
  for (let next = pending.pop(); next; next = pending.pop()) {
    const { value, depth } = next;
    if (depth > VEGA_LIMITS.depth) return null;
    if (Array.isArray(value)) {
      for (const item of value) pending.push({ value: item, depth });
      continue;
    }
    if (!isRecord(value)) continue;
    for (const [key, child] of Object.entries(value)) {
      const reading = readProperty(key, child);
      if (!reading) return null;
      rows += reading.rows;
      if (rows > VEGA_LIMITS.rows) return null;
      pending.push({ value: reading.nested, depth: depth + 1 });
    }
  }
  return rows;
}

const specSchema = z
  .record(z.string(), z.unknown())
  // Vega-Lite only. A raw Vega spec is a larger surface with its own loaders and expressions.
  .refine(({ $schema }) => typeof $schema !== "string" || !/\/vega\/v/i.test($schema))
  .refine((spec) => countRowsIfSelfContained(spec) !== null);

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

/** Returns null for anything that must not be handed to Vega; the caller then shows the source. */
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
