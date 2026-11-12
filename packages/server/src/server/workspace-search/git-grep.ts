import { StringDecoder } from "node:string_decoder";
import { tmpdir } from "node:os";
import { spawnProcess } from "../../utils/spawn.js";
import { NETWORK_PURPOSE } from "@pimi/protocol/network-activity";

export type RegexDialect = "pcre" | "basic";

export interface GitGrepOptions {
  /** The workspace root. Git reports paths relative to it and never searches above it. */
  cwd: string;
  query: string;
  isRegex: boolean;
  matchCase: boolean;
  wholeWord: boolean;
  /** Pathspecs from `buildPathspecs`. */
  pathspecs: string[];
  useIgnoreFiles: boolean;
  /** False when `cwd` is not inside a Git work tree; Git then searches the directory itself. */
  inGitWorkTree: boolean;
  dialect: RegexDialect;
  signal: AbortSignal;
}

export interface GitGrepRecord {
  path: string;
  line: number;
  text: string;
}

export interface GitGrepResult {
  exitCode: number | null;
  stderr: string;
  /** True when the caller's `onRecord` or `signal` ended the process before git finished. */
  stopped: boolean;
}

// One minified line can be megabytes. Past this a record is cut and the rest of its line dropped.
const MAX_RECORD_CHARS = 1_000_000;
const MAX_STDERR_CHARS = 8_192;

let pcreSupport: Promise<boolean> | null = null;

/** Whether this Git was built with PCRE. Probed once per daemon with a pattern that matches nothing. */
export function detectRegexDialect(): Promise<RegexDialect> {
  pcreSupport ??= new Promise<boolean>((resolve) => {
    const child = spawnProcess(
      "git",
      ["grep", "-P", "-q", "-e", "x", "--no-index", "--", "pimi-no-such-file"],
      { cwd: tmpdir(), shell: false, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", () => resolve(false));
    child.once("close", (code) =>
      resolve(code === 1 || (code === 0 && !/perl|pcre/i.test(stderr))),
    );
  });
  return pcreSupport.then((supported) => (supported ? "pcre" : "basic"));
}

/** Splits a byte stream into lines, cutting any line past MAX_RECORD_CHARS. */
class LineSplitter {
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";
  private overflowed = false;

  push(chunk: Buffer): string[] {
    const lines: string[] = [];
    let text = this.pending + this.decoder.write(chunk);
    let start = 0;
    for (let end = text.indexOf("\n", start); end !== -1; end = text.indexOf("\n", start)) {
      if (this.overflowed) this.overflowed = false;
      else lines.push(text.slice(start, Math.min(end, start + MAX_RECORD_CHARS)));
      start = end + 1;
    }
    text = text.slice(start);
    if (this.overflowed) text = "";
    else if (text.length > MAX_RECORD_CHARS) {
      lines.push(text.slice(0, MAX_RECORD_CHARS));
      this.overflowed = true;
      text = "";
    }
    this.pending = text;
    return lines;
  }
}

function buildArgs(options: GitGrepOptions): string[] {
  const args = [
    // Git runs repository-configured commands for fsmonitor; this is a read of the working tree.
    "-c",
    "core.fsmonitor=false",
    "grep",
    "-n",
    "-z",
    "-I",
    "--no-color",
    // Path then line then text, each NUL-terminated, so file names with spaces or colons parse.
    options.inGitWorkTree ? "--untracked" : "--no-index",
  ];
  // Ignore rules are `--exclude-standard`; with --no-index it is not the default.
  if (options.useIgnoreFiles) {
    if (!options.inGitWorkTree) args.push("--exclude-standard");
  } else if (options.inGitWorkTree) {
    args.push("--no-exclude-standard");
  }
  if (!options.matchCase) args.push("-i");
  if (options.wholeWord) args.push("-w");
  if (!options.isRegex) args.push("-F");
  else args.push(options.dialect === "pcre" ? "-P" : "-E");
  // The query is one argv entry after -e: git cannot read it as a flag, and no shell sees it.
  args.push("-e", options.query, "--", ...options.pathspecs);
  return args;
}

/**
 * Streams `git grep` matches to `onRecord`; return false from it to stop the search. Resolves when
 * the process has ended, whether git finished, the caller stopped it, or the signal aborted.
 */
export function runGitGrep(
  options: GitGrepOptions,
  onRecord: (record: GitGrepRecord) => boolean,
): Promise<GitGrepResult> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) {
      resolve({ exitCode: null, stderr: "", stopped: true });
      return;
    }
    const child = spawnProcess("git", buildArgs(options), {
      cwd: options.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      networkPurpose: NETWORK_PURPOSE.git,
    });
    const splitter = new LineSplitter();
    let stderr = "";
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      child.kill("SIGKILL");
    };
    options.signal.addEventListener("abort", stop, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stopped) return;
      for (const line of splitter.push(chunk)) {
        const record = parseRecord(line);
        if (record && !onRecord(record)) {
          stop();
          return;
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      options.signal.removeEventListener("abort", stop);
      reject(error);
    });
    child.once("close", (exitCode) => {
      options.signal.removeEventListener("abort", stop);
      resolve({ exitCode, stderr: stderr.slice(0, MAX_STDERR_CHARS), stopped });
    });
  });
}

function parseRecord(record: string): GitGrepRecord | null {
  const first = record.indexOf("\0");
  const second = first === -1 ? -1 : record.indexOf("\0", first + 1);
  if (second === -1) return null;
  const line = Number(record.slice(first + 1, second));
  if (!Number.isInteger(line) || line < 1) return null;
  return { path: record.slice(0, first), line, text: record.slice(second + 1) };
}

/** The first line of git's complaint, without its `fatal:` prefix and the echoed pattern. */
export function describeGitGrepFailure(stderr: string): string {
  const first = stderr.split("\n").find((line) => line.trim().length > 0) ?? "git grep failed";
  return first
    .replace(/^fatal:\s*/i, "")
    .replace(/^command line, '.*?':\s*/, "")
    .trim();
}
