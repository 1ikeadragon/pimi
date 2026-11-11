import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { dirname, relative, sep } from "node:path";
import type { CheckoutBlameResult } from "@pimi/protocol/messages";
import { resolveExplorerFilePath } from "../server/file-explorer/service.js";
import { parseDiff } from "../server/utils/diff-highlighter.js";
import {
  createRunGitCommand,
  runWithGitCommandPriority,
  type GitCommandOptions,
} from "./run-git-command.js";

const command = createRunGitCommand("editor-line-blame");
const runGit = (args: string[], options: GitCommandOptions) =>
  command(["-c", "protocol.allow=never", ...args], options);
// Match the editable-file limit, allowing the BOM stripped by PluginFile.readText.
const MAX_FILE_BYTES = 1024 * 1024 + 3;

interface CommitInfo {
  sha: string;
  author: string;
  authoredAt: string;
  summary: string;
}

/** Whole-file blame of one committed blob, shared by every line lookup. */
interface BlameEntry {
  /** CRLF-normalized committed text, kept to derive saved-to-committed line maps. */
  committed: string;
  lineCount: number;
  /** Per committed line (1-based): index into `commits`, or -1 when unattributed. */
  lineCommit: Int32Array;
  commits: CommitInfo[];
  /** saved content hash -> saved-line map; at most MAX_LINE_MAPS per entry. */
  lineMaps: Map<string, Promise<LineMap>>;
}

/** Saved line (1-based) -> committed line, 0 for lines the working text added or changed. */
type LineMap = Int32Array | { status: "changed" };

interface Resolution {
  root: string;
  gitPath: string;
  sha: string;
}

type Resolved = { resolution: Resolution } | { result: CheckoutBlameResult };

// One entry holds a <= 1 MiB blob plus ~8 bytes per line. 32 entries cover the files a
// person keeps open in editor tabs, with a worst case near 32 MiB of blobs.
const MAX_ENTRIES = 32;
const MAX_LINE_MAPS = 4;
// HEAD/tracked resolution is the only git work left on the per-line path. It is
// re-checked after this long, so a new commit is noticed within one TTL.
const RESOLUTION_TTL_MS = 1_000;
const MAX_RESOLUTIONS = 64;
// --porcelain prints a ~50 byte header per line; a 1 MiB file can reach ~500k lines.
const MAX_BLAME_BYTES = 32 * 1024 * 1024;
const BLAME_TIMEOUT_MS = 9_000;

const entries = new Map<string, Promise<BlameEntry | CheckoutBlameResult>>();
const resolutions = new Map<string, { at: number; value: Promise<Resolved> }>();

function gitOptions(cwd: string, signal: AbortSignal): GitCommandOptions {
  return {
    cwd,
    signal,
    timeout: 5_000,
    maxOutputBytes: 128 * 1024,
    envOverlay: {
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_LAZY_FETCH: "1",
      GIT_ALLOW_PROTOCOL: "",
      LC_ALL: "C",
    },
  };
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Attribute a line only against the exact saved text shown in the editor.
 * Git runs once per (repo, HEAD, file) and once per saved content; later lines are lookups.
 */
export async function getLineBlame(input: {
  cwd: string;
  path: string;
  line: number;
  contentHash: string;
  signal: AbortSignal;
}): Promise<CheckoutBlameResult> {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(BLAME_TIMEOUT_MS + 1_000)]);
  signal.throwIfAborted();
  const path = await resolveExplorerFilePath({ root: input.cwd, relativePath: input.path });
  const content = await readSavedText(path, signal);
  if (content === null) return { status: "unavailable" };
  if (createHash("sha256").update(content).digest("hex") !== input.contentHash)
    return { status: "stale" };
  // Git counts LF-delimited lines; CodeMirror also accepts standalone CRs.
  if (content.includes("\0") || /\r(?!\n)/.test(content)) return { status: "unavailable" };
  const lines = content ? content.split("\n").length - Number(content.endsWith("\n")) : 0;

  const resolved = await untilAborted(resolveCached(path), signal);
  if ("result" in resolved) return resolved.result;
  if (input.line > lines) return { status: "uncommitted" };
  const { root, gitPath, sha } = resolved.resolution;

  const entry = await untilAborted(loadEntry(root, gitPath, sha), signal);
  if ("status" in entry) return entry;
  const map = await untilAborted(loadLineMap(entry, content, input.contentHash, root), signal);
  if (!(map instanceof Int32Array)) return map;
  const original = map[input.line];
  if (!original) return { status: "uncommitted" };
  const index = entry.lineCommit[original];
  const commit = index >= 0 ? entry.commits[index] : undefined;
  return commit ? { status: "committed", ...commit } : { status: "unavailable" };
}

function resolveCached(path: string): Promise<Resolved> {
  const cached = resolutions.get(path);
  if (cached && Date.now() - cached.at < RESOLUTION_TTL_MS) return cached.value;
  const value = resolveUncached(path, AbortSignal.timeout(8_000));
  const record = { at: Date.now(), value };
  resolutions.delete(path);
  resolutions.set(path, record);
  while (resolutions.size > MAX_RESOLUTIONS) resolutions.delete(resolutions.keys().next().value!);
  const settle = (resolved: Resolved | null) => {
    // Transient failures are retried by the next request instead of cached.
    if (!resolved || ("result" in resolved && resolved.result.status === "unavailable")) {
      if (resolutions.get(path) === record) resolutions.delete(path);
    } else {
      record.at = Date.now();
    }
  };
  value.then(settle, () => settle(null));
  return value;
}

async function resolveUncached(path: string, signal: AbortSignal): Promise<Resolved> {
  const options = gitOptions(dirname(path), signal);
  const root = await runGit(["rev-parse", "--show-toplevel"], {
    ...options,
    acceptExitCodes: [0, 128],
  });
  if (root.truncated) return { result: { status: "unavailable" } };
  if (root.exitCode !== 0)
    return {
      result: { status: /not a git repository/.test(root.stderr) ? "not_git" : "unavailable" },
    };
  options.cwd = root.stdout.replace(/\r?\n$/, "");
  const gitPath = relative(options.cwd, path).split(sep).join("/");
  const tracked = await runGit(
    ["--literal-pathspecs", "ls-files", "--error-unmatch", "--", gitPath],
    { ...options, acceptExitCodes: [0, 1] },
  );
  if (tracked.truncated) return { result: { status: "unavailable" } };
  if (tracked.exitCode !== 0) return { result: { status: "untracked" } };
  const head = await runGit(["rev-parse", "--verify", "HEAD"], {
    ...options,
    acceptExitCodes: [0, 128],
  });
  if (head.exitCode !== 0) return { result: { status: "uncommitted" } };
  const sha = head.stdout.trim();
  if (!/^[a-f0-9]{40,64}$/.test(sha)) return { result: { status: "unavailable" } };
  return { resolution: { root: options.cwd, gitPath, sha } };
}

/** Concurrent requests for one (root, HEAD, path) share one in-flight blame. */
function loadEntry(
  root: string,
  gitPath: string,
  sha: string,
): Promise<BlameEntry | CheckoutBlameResult> {
  const key = `${root}\0${sha}\0${gitPath}`;
  const cached = entries.get(key);
  if (cached) {
    entries.delete(key);
    entries.set(key, cached); // LRU touch
    return cached;
  }
  const promise = runGitPriority(() =>
    buildEntry(root, gitPath, sha, AbortSignal.timeout(BLAME_TIMEOUT_MS)),
  );
  entries.set(key, promise);
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
  const evict = () => {
    if (entries.get(key) === promise) entries.delete(key);
  };
  // Failures are never cached, so Retry and later lines try again.
  promise.then(
    (entry) => ("status" in entry && entry.status === "unavailable" ? evict() : null),
    evict,
  );
  return promise;
}

function runGitPriority<T>(operation: () => Promise<T>): Promise<T> {
  return runWithGitCommandPriority("high", operation);
}

async function buildEntry(
  root: string,
  gitPath: string,
  sha: string,
  signal: AbortSignal,
): Promise<BlameEntry | CheckoutBlameResult> {
  const options = gitOptions(root, signal);
  // Read the immutable blob directly: working-tree reads through Git can run
  // repository-configured clean filters, including via blame --contents.
  const blob = await runGit(["cat-file", "blob", `${sha}:${gitPath}`], {
    ...options,
    maxOutputBytes: MAX_FILE_BYTES,
    acceptExitCodes: [0, 128],
  });
  if (blob.truncated) return { status: "unavailable" };
  if (blob.exitCode !== 0) return { status: "uncommitted" };
  const committed = blob.stdout.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
  const result = await runGit(
    ["blame", "--porcelain", "--no-progress", "--no-textconv", "--root", sha, "--", gitPath],
    {
      ...options,
      timeout: BLAME_TIMEOUT_MS,
      maxOutputBytes: MAX_BLAME_BYTES,
      acceptExitCodes: [0, 128],
    },
  );
  if (result.truncated || result.exitCode !== 0) return { status: "unavailable" };
  const lineCount = committed ? committed.split("\n").length - Number(committed.endsWith("\n")) : 0;
  const parsed = parseBlame(result.stdout, lineCount);
  if (!parsed) return { status: "unavailable" };
  return { committed, lineCount, ...parsed, lineMaps: new Map() };
}

function loadLineMap(
  entry: BlameEntry,
  content: string,
  contentHash: string,
  root: string,
): Promise<LineMap> {
  const cached = entry.lineMaps.get(contentHash);
  if (cached) return cached;
  const promise = buildLineMap(entry.committed, content.replaceAll("\r\n", "\n"), root);
  entry.lineMaps.set(contentHash, promise);
  while (entry.lineMaps.size > MAX_LINE_MAPS)
    entry.lineMaps.delete(entry.lineMaps.keys().next().value!);
  promise.catch(() => {
    if (entry.lineMaps.get(contentHash) === promise) entry.lineMaps.delete(contentHash);
  });
  return promise;
}

async function readSavedText(path: string, signal: AbortSignal): Promise<string | null> {
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_FILE_BYTES) return null;
    return buffer
      .subarray(0, length)
      .toString("utf8")
      .replace(/^\uFEFF/, "");
  } finally {
    await file.close();
  }
}

/** Run `git diff` once for this saved text and expand its hunks into a per-line map. */
async function buildLineMap(before: string, after: string, root: string): Promise<LineMap> {
  const lineCount = after ? after.split("\n").length - Number(after.endsWith("\n")) : 0;
  const map = new Int32Array(lineCount + 2);
  if (before === after) {
    for (let line = 1; line <= lineCount; line++) map[line] = line;
    return map;
  }
  const options = gitOptions(root, AbortSignal.timeout(8_000));
  const temp = await mkdtemp(`${tmpdir()}/pimi-line-blame-`);
  try {
    await Promise.all([
      writeFile(`${temp}/before`, before, { mode: 0o600 }),
      writeFile(`${temp}/after`, after, { mode: 0o600 }),
    ]);
    const diff = await runGit(
      [
        "-c",
        `core.attributesFile=${devNull}`,
        "diff",
        "--no-index",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--unified=0",
        "--",
        "before",
        "after",
      ],
      {
        ...options,
        cwd: temp,
        acceptExitCodes: [0, 1],
        maxOutputBytes: 3 * MAX_FILE_BYTES,
        envOverlay: {
          ...options.envOverlay,
          GIT_DIR: undefined,
          GIT_WORK_TREE: undefined,
          GIT_COMMON_DIR: undefined,
          GIT_CONFIG: undefined,
          GIT_CONFIG_COUNT: "0",
          GIT_CONFIG_PARAMETERS: undefined,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: devNull,
          GIT_CONFIG_SYSTEM: devNull,
          GIT_CEILING_DIRECTORIES: dirname(temp),
        },
      },
    );
    if (diff.truncated) return { status: "changed" };
    const parsed = parseDiff(diff.stdout);
    if (diff.exitCode !== 1 || parsed.length !== 1 || parsed[0].hunks.length === 0)
      return { status: "changed" };
    // Hunks are ordered; `delta` is saved-to-committed offset for lines after the last hunk.
    let delta = 0;
    let next = 1;
    const fill = (until: number) => {
      for (; next <= until && next <= lineCount; next++) map[next] = next + delta;
    };
    for (const hunk of parsed[0].hunks) {
      if (hunk.newCount === 0) {
        // Pure deletion: newStart is the saved line before the removed block.
        fill(hunk.newStart);
        delta += hunk.oldCount;
      } else {
        fill(hunk.newStart - 1);
        // Added or changed lines stay 0 (uncommitted).
        next = hunk.newStart + hunk.newCount;
        delta += hunk.oldCount - hunk.newCount;
      }
    }
    fill(lineCount);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  return map;
}

/** Parse `git blame --porcelain` (metadata appears once per commit) for the whole file. */
function parseBlame(
  stdout: string,
  lineCount: number,
): { lineCommit: Int32Array; commits: CommitInfo[] } | null {
  const output = stdout.split("\n");
  const lineCommit = new Int32Array(lineCount + 1).fill(-1);
  const commits: CommitInfo[] = [];
  const indexBySha = new Map<string, number>();
  let seen = 0;
  for (let i = 0; i < output.length; i++) {
    const header = /^([a-f0-9]{40,64}) \d+ (\d+)(?: \d+)?$/.exec(output[i]);
    if (!header) continue;
    const finalLine = Number(header[2]);
    if (finalLine < 1 || finalLine > lineCount) return null;
    seen++;
    let index = indexBySha.get(header[1]);
    const metadata = new Map<string, string>();
    for (i++; i < output.length && !output[i].startsWith("\t"); i++) {
      const record = output[i];
      const separator = record.indexOf(" ");
      if (separator !== -1) metadata.set(record.slice(0, separator), record.slice(separator + 1));
    }
    if (index === undefined) {
      index = -1;
      const author = metadata.get("author");
      const summary = metadata.get("summary");
      const seconds = Number(metadata.get("author-time"));
      const valid =
        author && summary !== undefined && Number.isFinite(seconds) && Math.abs(seconds) <= 8.64e12;
      // Uncommitted (all-zero) or malformed commits stay unattributed.
      if (valid && !/^0+$/.test(header[1])) {
        index = commits.length;
        commits.push({
          sha: header[1],
          author,
          authoredAt: new Date(seconds * 1000).toISOString(),
          summary,
        });
      }
      indexBySha.set(header[1], index);
    }
    lineCommit[finalLine] = index;
  }
  return seen === lineCount ? { lineCommit, commits } : null;
}
