export interface EnvLine {
  variable: string;
  value: string;
}

export interface ParsedEnv {
  lines: EnvLine[];
  /** Lines that were neither blank, a comment, nor `KEY=VALUE`. */
  skipped: number;
}

const ASSIGNMENT = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/**
 * The value after `=`. A quoted value ends at its closing quote, so `=` and `#` inside it
 * stay; an unquoted value ends at ` #`.
 */
function readValue(raw: string): string | null {
  const text = raw.trim();
  const quote = text[0];
  if (quote === '"' || quote === "'") {
    const end = text.indexOf(quote, 1);
    if (end === -1) return null;
    const rest = text.slice(end + 1).trim();
    if (rest.length > 0 && !rest.startsWith("#")) return null;
    return text.slice(1, end);
  }
  const comment = text.search(/\s#/);
  return (comment === -1 ? text : text.slice(0, comment)).trim();
}

export function parseEnv(text: string): ParsedEnv {
  const lines: EnvLine[] = [];
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const match = ASSIGNMENT.exec(trimmed);
    const value = match ? readValue(match[2]) : null;
    if (!match || value === null || value.length === 0) {
      skipped += 1;
      continue;
    }
    lines.push({ variable: match[1], value });
  }
  return { lines, skipped };
}
