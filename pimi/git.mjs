// Pimi addition to the Paseo fork. Apache-2.0.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const displayLimit = 400_000;
const diffArgs = ["--no-ext-diff", "--no-textconv", "--no-color", "--find-renames"];

export class RequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export async function command(program, args, cwd, { timeout = 8000, maxBuffer = 4 << 20 } = {}) {
  try {
    return (await exec(program, args, { cwd, timeout, maxBuffer, encoding: "utf8" })).stdout;
  } catch (error) {
    if (error.code === "ENOENT") throw new RequestError(`${program} is unavailable.`, 503);
    if (error.killed || error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new RequestError(`${program} exceeded the operation's time or output limit.`, 422);
    }
    const detail = error.stderr?.trim().split("\n").at(-1);
    throw new RequestError(detail || `${program} exited with status ${error.code}.`, 422);
  }
}

export const git = (cwd, ...args) =>
  command(
    "git",
    [
      "--no-optional-locks",
      "--literal-pathspecs",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    cwd,
  );

export async function repository(path) {
  return realpath((await git(path, "rev-parse", "--show-toplevel")).replace(/\n$/, ""));
}

export async function discoverWorktrees(root) {
  const output = await git(root, "worktree", "list", "--porcelain", "-z");
  const worktrees = [];
  for (const record of output.split("\0\0")) {
    const fields = record.split("\0");
    const value = (key) =>
      fields.find((field) => field.startsWith(key + " "))?.slice(key.length + 1);
    const directory = value("worktree");
    if (!directory || fields.includes("bare")) continue;
    worktrees.push({
      path: directory,
      repo: basename(root),
      head: value("HEAD"),
      branch: value("branch")?.replace(/^refs\/heads\//, "") ?? "Detached HEAD",
      unavailable: fields.some((field) => /^prunable(?: |$)/.test(field)),
    });
  }
  return worktrees;
}

export const commit = (cwd, ref) =>
  git(cwd, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`).then((x) => x.trim());

async function resolveBase(cwd, input) {
  if (input) return { label: input, sha: await commit(cwd, input) };
  const refs = (
    await git(cwd, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes")
  ).split("\n");
  const label =
    [
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
      "refs/remotes/origin/master",
      "refs/heads/main",
      "refs/heads/master",
    ].find((ref) => refs.includes(ref)) ?? "HEAD";
  return { label, sha: await commit(cwd, label) };
}

export async function worktreeFacts(worktree) {
  if (worktree.unavailable) return { ...worktree };
  try {
    const [status, base] = await Promise.all([
      git(worktree.path, "status", "--porcelain=v1", "-z", "--untracked-files=normal"),
      resolveBase(worktree.path),
    ]);
    const ahead = Number(
      (await git(worktree.path, "rev-list", "--count", `${base.sha}..HEAD`)).trim(),
    );
    return { ...worktree, dirty: Boolean(status), ahead };
  } catch (error) {
    return { ...worktree, error: error.message };
  }
}

async function pullRequest(cwd, url) {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/.exec(url);
  if (!match) throw new RequestError("Enter a GitHub pull request URL.");
  const [, owner, repo, number] = match;
  const pr = JSON.parse(
    await command(
      "gh",
      ["api", "--hostname", "github.com", `repos/${owner}/${repo}/pulls/${number}`],
      cwd,
    ),
  );
  const shaPattern = /^[0-9a-f]{40}$/;
  if (!shaPattern.test(pr.base.sha) || !shaPattern.test(pr.head.sha)) {
    throw new RequestError("GitHub returned an invalid commit ID.");
  }
  const refs = await Promise.allSettled([commit(cwd, pr.base.sha), commit(cwd, pr.head.sha)]);
  if (refs.some((result) => result.status === "rejected")) {
    // Fetch objects into the chosen local repository without changing a branch, index or worktree.
    await command(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "credential.helper=",
        "-c",
        "credential.helper=!gh auth git-credential",
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-recurse-submodules",
        "--no-auto-maintenance",
        `https://github.com/${owner}/${repo}.git`,
        pr.base.sha,
        pr.head.sha,
      ],
      cwd,
      { timeout: 45000 },
    );
  }
  const [base, head] = await Promise.all([commit(cwd, pr.base.sha), commit(cwd, pr.head.sha)]);
  return { base, head, label: `#${number} · ${pr.title}`, url };
}

export async function createReview(worktree, { baseRef, prUrl, mode }) {
  const cwd = worktree.path;
  const currentHead = await commit(cwd, "HEAD");
  const pr = prUrl ? await pullRequest(cwd, prUrl) : null;
  const base = pr
    ? { sha: pr.base, label: pr.label }
    : await resolveBase(cwd, mode === "working" ? "HEAD" : baseRef);
  const head = pr?.head ?? currentHead;
  const live = !pr && mode !== "committed";
  const mergeBase = (await git(cwd, "merge-base", base.sha, head)).trim();
  const refs = live ? [mergeBase] : [mergeBase, head];
  const fields = (await git(cwd, "diff", ...diffArgs, "--name-status", "-z", ...refs, "--")).split(
    "\0",
  );
  const files = [];
  for (let index = 0; fields[index]; ) {
    const status = fields[index++];
    const firstPath = fields[index++];
    const renamed = status.startsWith("R") || status.startsWith("C");
    const path = renamed ? fields[index++] : firstPath;
    files.push({ path, status, oldPath: renamed ? firstPath : undefined });
  }
  const untracked = live
    ? (await git(cwd, "ls-files", "--others", "--exclude-standard", "-z"))
        .split("\0")
        .filter(Boolean).length
    : 0;
  return {
    worktree,
    base,
    head,
    refs,
    files,
    live,
    pr,
    untracked,
    canOpenFiles: head === currentHead,
  };
}

export async function filePatch(review, file) {
  if (review.live && (await commit(review.worktree.path, "HEAD")) !== review.head) {
    throw new RequestError("The checkout moved. Refresh the review.", 409);
  }
  const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
  return git(
    review.worktree.path,
    "diff",
    ...diffArgs,
    "--unified=4",
    ...review.refs,
    "--",
    ...paths,
  );
}

export const patchFingerprint = (patch) => createHash("sha256").update(patch).digest("hex");

export function changedLines(patch) {
  const lines = new Set();
  let line = null;
  for (const text of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) line = Number(hunk[1]);
    else if (text.startsWith("diff --git ")) line = null;
    else if (line !== null && text.startsWith("+")) lines.add(line++);
    else if (line !== null && text.startsWith(" ")) line++;
  }
  return lines;
}

async function resolveFile(root, path) {
  const candidate = resolve(root, path);
  const fullPath = await realpath(candidate);
  const fromRoot = relative(root, fullPath);
  if (
    !fromRoot ||
    fromRoot === ".." ||
    fromRoot.startsWith(".." + sep) ||
    isAbsolute(fromRoot) ||
    !(await lstat(candidate)).isFile()
  ) {
    throw new RequestError("The selected file is outside this worktree or is unavailable.");
  }
  return fullPath;
}

export async function fileSource(review, file) {
  const cwd = review.worktree.path;
  let source;
  if (file.status === "D" || !review.live) {
    const revision = file.status === "D" ? review.refs[0] : review.head;
    const blob = `${revision}:${file.path}`;
    if ((await git(cwd, "cat-file", "-t", blob)).trim() !== "blob") {
      throw new RequestError("This Git entry has no text file to display.");
    }
    if (Number(await git(cwd, "cat-file", "-s", blob)) > displayLimit) {
      throw new RequestError("This file exceeds the 400 KB display limit.", 422);
    }
    source = await git(cwd, "cat-file", "blob", blob);
  } else {
    if ((await commit(cwd, "HEAD")) !== review.head) {
      throw new RequestError("The checkout moved. Refresh the review.", 409);
    }
    const filePath = await resolveFile(await realpath(cwd), file.path);
    const handle = await open(filePath, "r");
    try {
      const buffer = Buffer.alloc(displayLimit + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (chunk.bytesRead === 0) break;
        bytesRead += chunk.bytesRead;
      }
      if (bytesRead > displayLimit)
        throw new RequestError("This file exceeds the 400 KB display limit.", 422);
      source = buffer.toString("utf8", 0, bytesRead);
    } finally {
      await handle.close();
    }
  }
  if (source.includes("\0")) throw new RequestError("This is a binary file.");
  return source;
}

export async function openInEditor(review, file, line, launch = launchZed) {
  const root = await realpath(review.worktree.path);
  if (!file) return launch({ workspacePath: root });
  if (!review.canOpenFiles || file.status === "D" || (await commit(root, "HEAD")) !== review.head) {
    throw new RequestError("This file is unavailable at the current checkout.");
  }
  if (
    !review.live &&
    (await git(root, "diff", ...diffArgs, "--name-only", review.head, "--", file.path))
  ) {
    throw new RequestError(
      "The local file differs from the reviewed commit. Switch to a working comparison to open that version.",
      409,
    );
  }
  const fullPath = await resolveFile(root, file.path);
  return launch({ workspacePath: root, filePath: fullPath, line, column: 1 });
}

async function launchZed({ workspacePath, filePath, line, column }) {
  const args = filePath ? [workspacePath, `${filePath}:${line}:${column}`] : [workspacePath];
  await command("zed", args, workspacePath, { timeout: 12000 });
}
