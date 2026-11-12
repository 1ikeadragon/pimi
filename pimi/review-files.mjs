// Pimi. Apache-2.0.
import { lstat, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { command, fileSource, git, RequestError } from "./git.mjs";

const indexes = new WeakMap();
const statBatchSize = 32;
const missingFileCodes = new Set(["ENOENT", "ENOTDIR", "ELOOP"]);

function isRepoPath(path) {
  return (
    typeof path === "string" &&
    !path.includes("\0") &&
    !(process.platform === "win32" && /[:\\]/.test(path)) &&
    path
      .split("/")
      .every((part) => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git")
  );
}

function regularGitPaths(output) {
  return output
    .split("\0")
    .filter((entry) => /^100(?:644|755) /.test(entry))
    .map((entry) => entry.slice(entry.indexOf("\t") + 1))
    .filter(isRepoPath);
}

async function isRegularFile(root, path) {
  const candidate = join(root, path);
  try {
    if (!(await lstat(candidate)).isFile()) return false;
    return relative(candidate, await realpath(candidate)) === "";
  } catch (error) {
    if (missingFileCodes.has(error.code)) return false;
    throw error;
  }
}

async function worktreeRoot(cwd) {
  try {
    const root = await realpath(cwd);
    if (relative(cwd, root) === "") return root;
  } catch (error) {
    if (!missingFileCodes.has(error.code)) throw error;
  }
  throw new RequestError("The checkout is no longer available. Refresh the review.", 409);
}

async function indexReview(review) {
  const cwd = review.worktree.path;
  if (review.hosted) {
    throw new RequestError("Browse changed files for this hosted pull request.", 404);
  }
  if (!review.live) {
    if (!review.head) return new Set();
    const entries = await git(cwd, "ls-tree", "-r", "-z", "--full-tree", review.head);
    return new Set(regularGitPaths(entries).sort());
  }

  const root = await worktreeRoot(cwd);
  const [tracked, untracked] = await Promise.all([
    git(cwd, "ls-files", "--cached", "--stage", "-z"),
    git(cwd, "ls-files", "--others", "--exclude-standard", "-z"),
  ]);
  const candidates = [
    ...new Set([...regularGitPaths(tracked), ...untracked.split("\0").filter(isRepoPath)]),
  ].sort();
  const paths = new Set();
  for (let start = 0; start < candidates.length; start += statBatchSize) {
    const batch = candidates.slice(start, start + statBatchSize);
    const present = await Promise.all(batch.map((path) => isRegularFile(root, path)));
    batch.forEach((path, index) => {
      if (present[index]) paths.add(path);
    });
  }

  const head = await command(
    "git",
    ["--no-optional-locks", "rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
    cwd,
    {
      acceptExitOne: true,
    },
  );
  if ((head.trim() || null) !== review.head) {
    throw new RequestError("The checkout moved. Refresh the review.", 409);
  }
  return paths;
}

function reviewIndex(review) {
  let index = indexes.get(review);
  if (!index) {
    index = indexReview(review).catch((error) => {
      indexes.delete(review);
      throw error;
    });
    indexes.set(review, index);
  }
  return index;
}

export async function listReviewPaths(review) {
  return [...(await reviewIndex(review))];
}

export async function readReviewSource(review, path) {
  if (!isRepoPath(path) || !(await reviewIndex(review)).has(path)) {
    throw new RequestError("This file is not in the selected comparison.", 404);
  }
  if (review.live) {
    const root = await worktreeRoot(review.worktree.path);
    const entries = await git(
      root,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      path,
    );
    if (!entries.split("\0").includes(path) || !(await isRegularFile(root, path))) {
      throw new RequestError("This file is no longer available. Refresh the review.", 404);
    }
  }
  try {
    return await fileSource(review, { path });
  } catch (error) {
    if (missingFileCodes.has(error.code)) {
      throw new RequestError("This file is no longer available. Refresh the review.", 404);
    }
    throw error;
  }
}
