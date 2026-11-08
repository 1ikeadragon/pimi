// Pimi addition to the Paseo fork. Apache-2.0.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
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

export async function command(
  program,
  args,
  cwd,
  { timeout = 8000, maxBuffer = 4 << 20, acceptExitOne = false } = {},
) {
  try {
    return (await exec(program, args, { cwd, timeout, maxBuffer, encoding: "utf8" })).stdout;
  } catch (error) {
    if (acceptExitOne && error.code === 1) return error.stdout;
    if (error.code === "ENOENT") throw new RequestError(`${program} is unavailable.`, 503);
    if (error.killed || error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new RequestError(`${program} exceeded the operation's time or output limit.`, 422);
    }
    const detail = error.stderr?.trim().split("\n").at(-1);
    throw new RequestError(detail || `${program} exited with status ${error.code}.`, 422);
  }
}

const runGit = (cwd, args, options) =>
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
    options,
  );

export const git = (cwd, ...args) => runGit(cwd, args);

export async function repository(path) {
  return realpath((await git(path, "rev-parse", "--show-toplevel")).replace(/\r?\n$/, ""));
}

// Read configured fetch URLs without contacting a remote or changing Git state.
export async function repositoryRemotes(cwd) {
  const names = (await git(cwd, "remote")).trim().split("\n").filter(Boolean);
  const remotes = [];
  for (const name of names) {
    const url = (await git(cwd, "remote", "get-url", name)).trim();
    remotes.push({ name, url });
  }
  return remotes;
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
      path: process.platform === "win32" ? resolve(directory) : directory,
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

async function readHead(cwd) {
  const head = await runGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
    acceptExitOne: true,
  });
  return head.trim() || null;
}

async function reviewCheckout(path) {
  if ((await repository(path).catch(() => null)) !== path) return null;
  const [head, branch] = await Promise.all([
    readHead(path),
    runGit(path, ["symbolic-ref", "--quiet", "--short", "HEAD"], { acceptExitOne: true }),
  ]);
  return { path, repo: basename(path), branch: branch.trim() || "Detached HEAD", head };
}

export async function reviewTargets(directory) {
  const root = await realpath(directory);
  const checkout = await reviewCheckout(root);
  if (checkout?.head) return [checkout];

  // A blank chat can contain clones made by its agent. Only inspect its direct
  // children with Git metadata, and leave the choice to the user when there are several.
  const entries = await readdir(root, { withFileTypes: true });
  const nested = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const path = join(root, entry.name);
    if (!(await lstat(join(path, ".git")).catch(() => null))) continue;
    const candidate = await reviewCheckout(path);
    if (candidate) nested.push(candidate);
  }
  if (nested.length) return nested;
  return checkout ? [checkout] : [];
}

async function resolveBase(cwd, input) {
  if (input) {
    const sha = (
      await runGit(
        cwd,
        ["rev-parse", "--verify", "--quiet", "--end-of-options", `${input}^{commit}`],
        { acceptExitOne: true },
      )
    ).trim();
    if (!sha)
      throw new RequestError(
        `Base “${input}” was not found. Choose another ref or use Auto-detect.`,
      );
    return { label: input, sha };
  }
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

export async function worktreeFacts(worktree, baseRef) {
  if (worktree.unavailable) return { ...worktree };
  try {
    const [status, head] = await Promise.all([
      git(worktree.path, "status", "--porcelain=v1", "-z", "--untracked-files=normal"),
      readHead(worktree.path),
    ]);
    if (!head) return { ...worktree, dirty: Boolean(status), ahead: 0 };
    const base = await resolveBase(worktree.path, baseRef);
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
  const currentHead = await readHead(cwd);
  if (!currentHead && (baseRef || prUrl || mode === "committed")) {
    throw new RequestError("This checkout has no commits yet. Choose Working changes only.");
  }
  const pr = prUrl ? await pullRequest(cwd, prUrl) : null;
  let base;
  if (pr) base = { sha: pr.base, label: pr.label };
  else if (currentHead) base = await resolveBase(cwd, mode === "working" ? "HEAD" : baseRef);
  else
    base = {
      sha: (await git(cwd, "hash-object", "-t", "tree", "/dev/null")).trim(),
      label: "Empty tree",
    };
  const head = pr?.head ?? currentHead;
  const live = !pr && mode !== "committed";
  const mergeBase = head
    ? (await runGit(cwd, ["merge-base", base.sha, head], { acceptExitOne: true })).trim()
    : base.sha;
  if (!mergeBase) {
    throw new RequestError(
      "This branch and its base have no common commit. Choose another base or Working changes only.",
    );
  }
  const refs = live ? [mergeBase] : [mergeBase, head];
  const files = await listReviewFiles(cwd, refs, live);
  return {
    worktree,
    base,
    head,
    refs,
    files,
    live,
    pr,
    canOpenFiles: head === currentHead,
  };
}

async function listReviewFiles(cwd, refs, live) {
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
  if (live) {
    const tracked = new Set(files.map(({ path }) => path));
    const untracked = await git(cwd, "ls-files", "--others", "--exclude-standard", "-z");
    for (const path of untracked.split("\0")) {
      // Git lists untracked nested repositories as a directory, never as individual files.
      if (path && !path.endsWith("/") && !tracked.has(path))
        files.push({ path, status: "A", untracked: true });
    }
  }
  return files;
}

async function untrackedDiff(cwd, path, args) {
  const file = await resolveFile(cwd, path);
  if ((await lstat(file)).size > displayLimit) {
    throw new RequestError("This file exceeds the 400 KB display limit.", 422);
  }
  return runGit(
    cwd,
    ["diff", "--no-index", ...diffArgs, ...args, "--", "/dev/null", relative(cwd, file)],
    {
      acceptExitOne: true,
    },
  );
}

function sumNumstat(output) {
  let additions = 0;
  let deletions = 0;
  const fields = output.split("\0");
  for (let index = 0; index < fields.length && fields[index]; index++) {
    const entry = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[index]);
    if (!entry) throw new Error("Git returned an invalid line count.");
    additions += Number(entry[1]) || 0;
    deletions += Number(entry[2]) || 0;
    if (!entry[3]) index += 2;
  }
  return { additions, deletions };
}

export async function summarizeReviewDirectory(directory) {
  const targets = await reviewTargets(directory);
  if (targets.length !== 1) return null;
  const review = await createReview(targets[0], { baseRef: "", prUrl: "", mode: "all" });
  if (!review.files.length) return null;
  const cwd = review.worktree.path;
  const totals = sumNumstat(
    await git(cwd, "diff", ...diffArgs, "--numstat", "-z", ...review.refs, "--"),
  );
  const untracked = review.files.filter((file) => file.untracked);
  // Keep live counts responsive for generated trees. The file list remains complete.
  const maxUntrackedLineCounts = 64;
  let incomplete = untracked.length > maxUntrackedLineCounts;
  for (const file of untracked.slice(0, maxUntrackedLineCounts)) {
    try {
      const stat = sumNumstat(await untrackedDiff(cwd, file.path, ["--numstat", "-z"]));
      totals.additions += stat.additions;
    } catch {
      incomplete = true;
    }
  }
  return { filesChanged: review.files.length, ...totals, incomplete };
}

export async function filePatch(review, file) {
  if (review.hosted) return review.hosted.patch(file);
  if (review.live && (await readHead(review.worktree.path)) !== review.head) {
    throw new RequestError("The checkout moved. Refresh the review.", 409);
  }
  if (file.untracked) return untrackedDiff(review.worktree.path, file.path, ["--unified=4"]);
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
  if (review.hosted) return review.hosted.source(file);
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
    if ((await readHead(cwd)) !== review.head) {
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
  if (!review.canOpenFiles || file.status === "D" || (await readHead(root)) !== review.head) {
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
