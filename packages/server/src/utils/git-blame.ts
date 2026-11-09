import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { dirname, relative, sep } from "node:path";
import type { CheckoutBlameResult } from "@pimi/protocol/messages";
import { resolveExplorerFilePath } from "../server/file-explorer/service.js";
import { parseDiff } from "../server/utils/diff-highlighter.js";
import { createRunGitCommand, type GitCommandOptions } from "./run-git-command.js";

const command = createRunGitCommand("editor-line-blame");
const runGit = (args: string[], options: GitCommandOptions) =>
  command(["-c", "protocol.allow=never", ...args], options);
// Match the editable-file limit, allowing the BOM stripped by PluginFile.readText.
const MAX_FILE_BYTES = 1024 * 1024 + 3;

/** Attribute a line only against the exact saved text shown in the editor. */
export async function getLineBlame(input: {
  cwd: string;
  path: string;
  line: number;
  contentHash: string;
  signal: AbortSignal;
}): Promise<CheckoutBlameResult> {
  input = { ...input, signal: AbortSignal.any([input.signal, AbortSignal.timeout(8_000)]) };
  input.signal.throwIfAborted();
  const path = await resolveExplorerFilePath({ root: input.cwd, relativePath: input.path });
  const content = await readSavedText(path, input.signal);
  if (content === null) return { status: "unavailable" };
  if (createHash("sha256").update(content).digest("hex") !== input.contentHash)
    return { status: "stale" };
  // Git counts LF-delimited lines; CodeMirror also accepts standalone CRs.
  if (content.includes("\0") || /\r(?!\n)/.test(content)) return { status: "unavailable" };
  const lines = content ? content.split("\n").length - Number(content.endsWith("\n")) : 0;

  const options: GitCommandOptions = {
    cwd: dirname(path),
    signal: input.signal,
    timeout: 5_000,
    maxOutputBytes: 128 * 1024,
    envOverlay: {
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_LAZY_FETCH: "1",
      GIT_ALLOW_PROTOCOL: "",
      LC_ALL: "C",
    },
  };
  const root = await runGit(["rev-parse", "--show-toplevel"], {
    ...options,
    acceptExitCodes: [0, 128],
  });
  if (root.truncated) return { status: "unavailable" };
  if (root.exitCode !== 0)
    return { status: /not a git repository/.test(root.stderr) ? "not_git" : "unavailable" };
  options.cwd = root.stdout.replace(/\r?\n$/, "");
  const gitPath = relative(options.cwd, path).split(sep).join("/");
  const tracked = await runGit(
    ["--literal-pathspecs", "ls-files", "--error-unmatch", "--", gitPath],
    {
      ...options,
      acceptExitCodes: [0, 1],
    },
  );
  if (tracked.truncated) return { status: "unavailable" };
  if (tracked.exitCode !== 0) return { status: "untracked" };
  if (input.line > lines) return { status: "uncommitted" };
  const head = await runGit(["rev-parse", "--verify", "HEAD"], {
    ...options,
    acceptExitCodes: [0, 128],
  });
  if (head.exitCode !== 0) return { status: "uncommitted" };
  const sha = head.stdout.trim();
  if (!/^[a-f0-9]{40,64}$/.test(sha)) return { status: "unavailable" };
  // Read the immutable blob directly: working-tree reads through Git can run
  // repository-configured clean filters, including via blame --contents.
  const blob = await runGit(["cat-file", "blob", `${sha}:${gitPath}`], {
    ...options,
    maxOutputBytes: MAX_FILE_BYTES,
    acceptExitCodes: [0, 128],
  });
  if (blob.truncated) return { status: "unavailable" };
  if (blob.exitCode !== 0) return { status: "uncommitted" };
  const committed = blob.stdout.replace(/^\uFEFF/, "");
  const originalLine = await mapSavedLine(
    committed.replaceAll("\r\n", "\n"),
    content.replaceAll("\r\n", "\n"),
    input.line,
    options,
  );
  if (typeof originalLine !== "number") return originalLine;
  const result = await runGit(
    [
      "blame",
      "--line-porcelain",
      "--no-progress",
      "--no-textconv",
      "--root",
      "-L",
      `${originalLine},${originalLine}`,
      sha,
      "--",
      gitPath,
    ],
    { ...options, acceptExitCodes: [0, 128] },
  );
  if (result.truncated) return { status: "unavailable" };
  if (result.exitCode !== 0) return { status: "unavailable" };
  return parseLineAttribution(result.stdout, originalLine);
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

async function mapSavedLine(
  before: string,
  after: string,
  line: number,
  options: GitCommandOptions,
): Promise<number | CheckoutBlameResult> {
  let originalLine = line;
  if (before === after) return line;
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
    for (const hunk of parsed[0].hunks) {
      if (hunk.newCount === 0) {
        if (line > hunk.newStart) originalLine += hunk.oldCount;
      } else {
        if (line >= hunk.newStart && line < hunk.newStart + hunk.newCount)
          return { status: "uncommitted" };
        if (line >= hunk.newStart + hunk.newCount) originalLine += hunk.oldCount - hunk.newCount;
      }
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  return originalLine;
}

function parseLineAttribution(stdout: string, originalLine: number): CheckoutBlameResult {
  const output = stdout.split("\n");
  const header = /^([a-f0-9]{40,64}) \d+ (\d+)(?: \d+)?$/.exec(output[0] ?? "");
  if (!header || Number(header[2]) !== originalLine) return { status: "unavailable" };
  if (/^0+$/.test(header[1])) return { status: "uncommitted" };
  const metadata = new Map<string, string>();
  for (const record of output.slice(1)) {
    if (record.startsWith("\t")) break;
    const separator = record.indexOf(" ");
    if (separator !== -1) metadata.set(record.slice(0, separator), record.slice(separator + 1));
  }
  const author = metadata.get("author");
  const summary = metadata.get("summary");
  const seconds = Number(metadata.get("author-time"));
  if (!author || summary === undefined || !Number.isFinite(seconds) || Math.abs(seconds) > 8.64e12)
    return { status: "unavailable" };
  return {
    status: "committed",
    sha: header[1],
    author,
    authoredAt: new Date(seconds * 1000).toISOString(),
    summary,
  };
}
