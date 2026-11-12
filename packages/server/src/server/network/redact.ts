// Redaction for what the Network tab and its log files keep about a launched program or an
// inbound request path. The rules lean toward over-redaction: a hidden argument costs a little
// detail, a leaked credential costs far more. Environment variables are never passed in.

const REDACTED = "[redacted]";
const MAX_ARGUMENT_CHARS = 120;
const MAX_ARGUMENTS_CHARS = 240;

// Flags whose value is a credential or carries one. Matched on the flag name, so `--token x`,
// `--token=x`, `--api-key x`, and `-H "Authorization: ..."` all hide the value.
const SENSITIVE_FLAG =
  /token|password|passwd|secret|api-?key|auth|bearer|cookie|credential|header|private-?key/i;
const SENSITIVE_SHORT_FLAGS = new Set(["-H", "-u"]);
const SENSITIVE_ASSIGNMENT_KEY =
  /token|secret|password|passwd|api_?key|auth|credential|private_?key/i;

const TOKEN_PATTERNS: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+\S+/gi,
  /\bBasic\s+[A-Za-z0-9+/=]{8,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
];

const HEX_RUN = /[0-9a-fA-F]{32,}/g;
const GIT_OBJECT_ID_LENGTHS = new Set([40, 64]);
const USERINFO = /([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]+@/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_TOKEN_SEGMENT = /^[A-Za-z0-9+_-]{32,}={0,2}$/;

export function commandBasename(command: string): string {
  const base = command.split(/[\\/]/).pop() ?? command;
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, "") || command;
}

function hasLetterAndDigit(value: string): boolean {
  return /[A-Za-z]/.test(value) && /\d/.test(value);
}

function scrubKnownTokens(value: string, keepGitObjectIds: boolean): string {
  let scrubbed = value.replace(USERINFO, `$1${REDACTED}@`);
  for (const pattern of TOKEN_PATTERNS) scrubbed = scrubbed.replace(pattern, REDACTED);
  scrubbed = scrubbed.replace(HEX_RUN, (run) =>
    keepGitObjectIds && GIT_OBJECT_ID_LENGTHS.has(run.length) ? run : REDACTED,
  );
  return scrubbed;
}

/** Masks one path segment that looks like a credential. UUIDs and git object ids are kept. */
function scrubSegment(segment: string, keepGitObjectIds: boolean): string {
  if (UUID.test(segment)) return segment;
  const scrubbed = scrubKnownTokens(segment, keepGitObjectIds);
  if (scrubbed !== segment) return scrubbed;
  if (LONG_TOKEN_SEGMENT.test(segment) && hasLetterAndDigit(segment)) return REDACTED;
  return segment;
}

function scrubArgument(argument: string, keepGitObjectIds: boolean): string {
  // Everything after ? or # is a query string or fragment: never kept.
  const cut = argument.search(/[?#]/);
  const bare = cut === -1 ? argument : `${argument.slice(0, cut)}…`;
  const assignment = /^([A-Za-z_][\w.-]*)=(.*)$/s.exec(bare);
  if (assignment && SENSITIVE_ASSIGNMENT_KEY.test(assignment[1]!)) {
    return `${assignment[1]}=${REDACTED}`;
  }
  const scrubbed = bare
    .split("/")
    .map((segment) => scrubSegment(segment, keepGitObjectIds))
    .join("/");
  return scrubbed.length > MAX_ARGUMENT_CHARS
    ? `${scrubbed.slice(0, MAX_ARGUMENT_CHARS)}…`
    : scrubbed;
}

function isSensitiveFlag(flag: string): boolean {
  return SENSITIVE_SHORT_FLAGS.has(flag) || (flag.startsWith("--") && SENSITIVE_FLAG.test(flag));
}

/**
 * The arguments of a launched program as safe display text. Flag values that carry credentials
 * are hidden, git's `-c key=value` pairs are dropped (they can hold headers and tokens), URL
 * credentials, query strings, and token-shaped strings are masked, and long output is cut.
 */
export function redactArgv(command: string, args: readonly string[]): string {
  const isGit = commandBasename(command) === "git";
  const parts: string[] = [];
  let hideNext = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (hideNext) {
      hideNext = false;
      parts.push(REDACTED);
      continue;
    }
    if (isGit && (argument === "-c" || argument === "--config-env")) {
      index += 1;
      continue;
    }
    if (isGit && argument.startsWith("--config-env=")) continue;
    const flag = /^(-{1,2}[A-Za-z][\w-]*)(=.*)?$/s.exec(argument);
    if (flag && isSensitiveFlag(flag[1]!)) {
      if (flag[2] !== undefined) parts.push(`${flag[1]}=${REDACTED}`);
      else {
        parts.push(flag[1]!);
        hideNext = true;
      }
      continue;
    }
    // `-Hvalue` and `-uuser:pass` attach the value to a sensitive short flag.
    if (/^-[Hu]./s.test(argument) && !argument.startsWith("--")) {
      parts.push(`${argument.slice(0, 2)}${REDACTED}`);
      continue;
    }
    parts.push(scrubArgument(argument, isGit));
  }
  const joined = parts.join(" ");
  return joined.length > MAX_ARGUMENTS_CHARS ? `${joined.slice(0, MAX_ARGUMENTS_CHARS)}…` : joined;
}

const OUTLINE_SUBCOMMAND = /^[A-Za-z][\w-]{0,23}$/;

/**
 * Only the shape of a command line: flag names without values, plus short bare words such as
 * `serve` or `app-server`. For programs whose arguments can carry prompts, inline JSON
 * configuration, or credentials in forms no pattern would catch.
 */
export function outlineArgv(args: readonly string[]): string {
  const parts: string[] = [];
  for (const argument of args) {
    if (argument.startsWith("-")) {
      const equals = argument.indexOf("=");
      const name = equals === -1 ? argument : argument.slice(0, equals);
      if (/^-{1,2}[A-Za-z][\w-]*$/.test(name)) parts.push(equals === -1 ? name : `${name}=…`);
    } else if (OUTLINE_SUBCOMMAND.test(argument) && !/^\d+$/.test(argument)) {
      parts.push(argument);
    }
  }
  return parts.join(" ");
}

/** A request path with credential-shaped segments masked. The query string is dropped. */
export function maskPathSegments(path: string): string {
  const cut = path.search(/[?#]/);
  const bare = cut === -1 ? path : path.slice(0, cut);
  return bare
    .split("/")
    .map((segment) => scrubSegment(segment, false))
    .join("/");
}
