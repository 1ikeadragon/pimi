/** What the agent manager needs from the vault to keep secret values out of timelines. */
export interface OutputRedactor {
  /** False while no secret value is loaded, so callers can skip the walk entirely. */
  readonly redactionActive: boolean;
  redact(text: string): string;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function walk(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) {
    let changed = false;
    const mapped = value.map((entry) => {
      const next = walk(entry, redact);
      if (next !== entry) changed = true;
      return next;
    });
    return changed ? mapped : value;
  }
  if (typeof value === "object" && value !== null && isPlainObject(value)) {
    let changed = false;
    const mapped: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const next = walk(entry, redact);
      if (next !== entry) changed = true;
      mapped[key] = next;
    }
    return changed ? mapped : value;
  }
  return value;
}

/**
 * Applies `redact` to every string reachable through plain objects and arrays, keeping the shape.
 * The value is returned unchanged (same reference) when nothing in it needed redacting. Only
 * string contents change, never keys, so the return type is the input type.
 */
export function redactStrings<T>(value: T, redactor: OutputRedactor): T {
  if (!redactor.redactionActive) return value;
  // A generic structural map cannot be expressed in the type system; string leaves are replaced by
  // strings, which preserves T.
  return walk(value, (text) => redactor.redact(text)) as T;
}
