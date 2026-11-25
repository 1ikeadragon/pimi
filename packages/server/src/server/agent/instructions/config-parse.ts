/**
 * Small readers for the few settings instruction discovery needs. The server declares no TOML,
 * JSONC or glob dependency, and these files are read only for three or four known keys, so each
 * reader handles exactly that subset and reports what it could not read instead of guessing.
 */

export type ConfigReadResult<T> = { ok: true; value: T } | { ok: false; message: string };

// ---
// JSONC (opencode.json, settings.json)

/** Removes comments and trailing commas outside strings, then parses. */
export function parseJsonc(text: string): ConfigReadResult<unknown> {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      out += char;
      if (char === "\\") {
        i += 1;
        out += text[i] ?? "";
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
    } else if (char === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
    } else {
      out += char;
    }
  }
  const withoutTrailingCommas = stripTrailingCommas(out);
  try {
    return { ok: true, value: JSON.parse(withoutTrailingCommas) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      out += char;
      if (char === "\\") {
        i += 1;
        out += text[i] ?? "";
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] ?? "")) j += 1;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += char;
  }
  return out;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : null;
}

// ---
// TOML (codex config.toml): top-level keys only

/**
 * Reads top-level `key = value` pairs before the first `[table]` header. Values are integers,
 * booleans, quoted strings, or single-line arrays of quoted strings. Anything else is ignored.
 * Tables (`[profiles.x]`) are not read: Codex applies them only when selected, and Pimi does not
 * select a profile.
 */
export function readTomlTopLevel(text: string): Map<string, string | number | boolean | string[]> {
  const values = new Map<string, string | number | boolean | string[]>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (line.length === 0) continue;
    if (line.startsWith("[")) break;
    const equals = line.indexOf("=");
    if (equals === -1) continue;
    const key = line.slice(0, equals).trim();
    const raw = line.slice(equals + 1).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(key)) continue;
    const parsed = parseTomlValue(raw);
    if (parsed !== undefined) values.set(key, parsed);
  }
  return values;
}

function stripTomlComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote) {
      if (char === "\\" && quote === '"') i += 1;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseTomlValue(raw: string): string | number | boolean | string[] | undefined {
  if (/^-?\d[\d_]*$/.test(raw)) return Number(raw.replaceAll("_", ""));
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return undefined;
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) return raw.slice(1, -1);
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const items: string[] = [];
    for (const match of raw.slice(1, -1).matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)) {
      items.push(match[2] ?? (JSON.parse(`"${match[1] ?? ""}"`) as string));
    }
    return items;
  }
  return undefined;
}

// ---
// Globs (claudeMdExcludes, opencode `instructions`)

/** Converts `**`, `*`, `?` and `{a,b}` to a regular expression over `/`-separated paths. */
export function globToRegExp(glob: string): RegExp {
  const normalized = glob.replaceAll("\\", "/");
  let source = "";
  let braceDepth = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i] ?? "";
    if (char === "*") {
      if (normalized[i + 1] === "*") {
        const slashAfter = normalized[i + 2] === "/";
        source += slashAfter ? "(?:.*/)?" : ".*";
        i += slashAfter ? 2 : 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "{") {
      braceDepth += 1;
      source += "(?:";
    } else if (char === "}" && braceDepth > 0) {
      braceDepth -= 1;
      source += ")";
    } else if (char === "," && braceDepth > 0) {
      source += "|";
    } else {
      source += char.replace(/[.+^$()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

export function hasGlobMagic(value: string): boolean {
  return /[*?{]/.test(value);
}
