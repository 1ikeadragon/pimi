// Replaces secret values, and common encodings of them, in text before it leaves the daemon.
// This is a backstop for output the daemon itself produces; it cannot see a value that was
// transformed (reversed, split, hashed, encrypted) by the program that printed it.

// A value shorter than this is not registered. Random base62 text of 8 characters carries about
// 47 bits, the shortest length that is still unguessable-by-chance; anything shorter ("true",
// "1234", a username) would also match ordinary output and corrupt it. The UI flags such secrets
// as "not redacted" through `Redactor.isRegistered`.
export const MIN_REDACTABLE_LENGTH = 8;

export interface RedactorSecret {
  name: string;
  value: string;
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function percentEncodeStrict(value: string): string {
  return [...Buffer.from(value, "utf8")]
    .map((byte) => {
      const char = String.fromCharCode(byte);
      return /[A-Za-z0-9\-._~]/.test(char)
        ? char
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
}

function asciiJsonEscape(value: string): string {
  return JSON.stringify(value)
    .slice(1, -1)
    .replace(/[^\x20-\x7e]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * The substrings of base64(prefix + bytes + suffix) that depend only on `bytes`, for the three
 * ways the value can sit relative to a 3-byte group. The characters that mix in a neighbouring
 * byte are dropped from both ends, so the result matches wherever the value is embedded.
 */
function base64Windows(bytes: Buffer): string[] {
  const windows: string[] = [];
  for (const prefixBytes of [0, 1, 2]) {
    const total = prefixBytes + bytes.length;
    const encoded = Buffer.concat([Buffer.alloc(prefixBytes), bytes]).toString("base64");
    const remainder = total % 3;
    const unpaddedLength = Math.floor(total / 3) * 4 + (remainder === 0 ? 0 : remainder + 1);
    const end = remainder === 0 ? unpaddedLength : unpaddedLength - 1;
    const start = prefixBytes === 0 ? 0 : prefixBytes + 1;
    if (end > start) windows.push(encoded.slice(start, end));
  }
  return windows;
}

function toBase64Url(standard: string): string {
  return standard.replace(/\+/g, "-").replace(/\//g, "_");
}

function variantsOf(value: string): string[] {
  const bytes = Buffer.from(value, "utf8");
  const standard = base64Windows(bytes);
  const percent = encodeURIComponent(value);
  const variants = [
    value,
    JSON.stringify(value).slice(1, -1),
    asciiJsonEscape(value),
    ...standard,
    ...standard.map(toBase64Url),
    bytes.toString("hex"),
    bytes.toString("hex").toUpperCase(),
    percent,
    percent.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()),
    percent.replace(/%20/g, "+"),
    percentEncodeStrict(value),
  ];
  return variants;
}

function registrableValues(value: string): string[] {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= MIN_REDACTABLE_LENGTH);
  return value.includes("\n") ? [value, ...lines] : [value];
}

interface Replacement {
  start: number;
  end: number;
  text: string;
}

export class Redactor {
  readonly maxVariantLength: number;
  private readonly pattern: RegExp | null;
  private readonly markerByVariant: Map<string, string>;
  private readonly registeredNames: ReadonlySet<string>;

  constructor(secrets: readonly RedactorSecret[]) {
    const markers = new Map<string, string>();
    const registered = new Set<string>();
    for (const secret of secrets) {
      if (secret.value.length < MIN_REDACTABLE_LENGTH) continue;
      registered.add(secret.name);
      for (const piece of registrableValues(secret.value)) {
        for (const variant of variantsOf(piece)) {
          if (variant.length >= MIN_REDACTABLE_LENGTH && !markers.has(variant)) {
            markers.set(variant, `[redacted:${secret.name}]`);
          }
        }
      }
    }
    this.markerByVariant = markers;
    this.registeredNames = registered;
    // Longest first so an alternation prefers the longest variant at a position.
    const ordered = [...markers.keys()].sort((a, b) => b.length - a.length);
    this.maxVariantLength = ordered.length > 0 ? ordered[0].length : 0;
    this.pattern =
      ordered.length > 0 ? new RegExp(ordered.map(escapeForRegExp).join("|"), "g") : null;
  }

  get isEmpty(): boolean {
    return this.pattern === null;
  }

  /** Whether the secret's value is long enough to be matched in output. */
  isRegistered(name: string): boolean {
    return this.registeredNames.has(name);
  }

  redact(text: string): string {
    if (!this.pattern) return text;
    const replacements = this.findReplacements(text);
    return applyReplacements(text, replacements, text.length);
  }

  stream(): RedactingStream {
    return new RedactingStream(this);
  }

  /** Non-overlapping, left-to-right matches of any variant in `text`. */
  findReplacements(text: string): Replacement[] {
    if (!this.pattern) return [];
    const replacements: Replacement[] = [];
    for (const match of text.matchAll(this.pattern)) {
      const marker = this.markerByVariant.get(match[0]);
      if (marker === undefined) continue;
      replacements.push({ start: match.index, end: match.index + match[0].length, text: marker });
    }
    return replacements;
  }
}

function applyReplacements(text: string, replacements: Replacement[], upTo: number): string {
  let output = "";
  let cursor = 0;
  for (const replacement of replacements) {
    if (replacement.end > upTo) break;
    output += text.slice(cursor, replacement.start) + replacement.text;
    cursor = replacement.end;
  }
  return output + text.slice(cursor, upTo);
}

/**
 * Redacts text that arrives in pieces. It holds back the last `maxVariantLength - 1` characters of
 * what it has seen, because a value cut by a chunk boundary starts inside that tail.
 */
export class RedactingStream {
  private carry = "";

  constructor(private readonly redactor: Redactor) {}

  /** Returns the text that is now safe to emit. */
  push(chunk: string): string {
    if (this.redactor.isEmpty) return chunk;
    const buffer = this.carry + chunk;
    const replacements = this.redactor.findReplacements(buffer);
    let safe = Math.max(0, buffer.length - (this.redactor.maxVariantLength - 1));
    for (const replacement of replacements) {
      if (replacement.start >= safe) break;
      if (replacement.end > safe) safe = replacement.end;
    }
    this.carry = buffer.slice(safe);
    return applyReplacements(buffer, replacements, safe);
  }

  /** The stream ended normally: scan and release whatever is held back. */
  finish(): string {
    const rest = this.redactor.redact(this.carry);
    this.carry = "";
    return rest;
  }

  /**
   * The stream was cut (output cap, kill). The held-back tail may begin a value whose end was
   * never seen, so it is dropped instead of released.
   */
  discard(): void {
    this.carry = "";
  }
}
