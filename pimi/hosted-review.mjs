// Pimi addition to the Paseo fork. Apache-2.0.
import { command, displayLimit, RequestError } from "./git.mjs";

const snapshotLimit = 8 << 20;
const githubFileLimit = 3000;
let active = 0;
const waiting = [];
let opening = 0;

async function github(endpoint) {
  if (waiting.length >= 64)
    throw new RequestError("Too many hosted PR reads are pending. Try again shortly.", 429);
  if (active >= 3) await new Promise((resolve) => waiting.push(resolve));
  else active++;
  try {
    return JSON.parse(
      await command(
        "gh",
        ["api", "--hostname", "github.com", "--method", "GET", endpoint],
        undefined,
        { timeout: 12_000, maxBuffer: snapshotLimit },
      ),
    );
  } catch {
    // Do not expose CLI stderr: it can contain credentials or remote response text.
    throw new RequestError(
      "GitHub could not load this PR or file. Check gh authentication, repository access, and your connection.",
      502,
    );
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}

function validateSnapshot(pr) {
  if (
    !/^[a-f0-9]{40}$/.test(pr.head?.sha) ||
    !/^[a-f0-9]{40}$/.test(pr.base?.sha) ||
    !Number.isSafeInteger(pr.changed_files) ||
    pr.changed_files < 0
  ) {
    throw new RequestError("GitHub returned an invalid PR snapshot.", 502);
  }
  if (pr.changed_files > githubFileLimit)
    throw new RequestError(
      "GitHub's file API only returns up to 3,000 files. Open this PR on GitHub for the complete diff.",
      422,
    );
}

function patchFor(file) {
  if (typeof file.patch !== "string") {
    if (file.status === "renamed" && file.changes === 0)
      return `rename from ${file.previous_filename}\nrename to ${file.filename}\n`;
    throw new RequestError(
      "GitHub did not provide a text patch for this file. It may be binary or too large; open it on GitHub.",
      422,
    );
  }
  if (Buffer.byteLength(file.patch) > displayLimit)
    throw new RequestError("This patch exceeds the 400 KB display limit.", 422);
  // GitHub can omit/truncate large patches. Never present a partial patch as complete.
  const lines = file.patch.split("\n");
  const additions = lines.filter((line) => line.startsWith("+")).length;
  const deletions = lines.filter((line) => line.startsWith("-")).length;
  if (additions !== file.additions || deletions !== file.deletions)
    throw new RequestError(
      "GitHub returned an incomplete patch for this file. Open it on GitHub for the full diff.",
      422,
    );
  return file.patch;
}

export async function createHostedReview(url) {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)\/?$/.exec(url);
  if (!match || !Number.isSafeInteger(Number(match[2])))
    throw new RequestError("Enter a GitHub pull request URL.");
  if (opening >= 2) throw new RequestError("Other hosted PRs are loading. Try again shortly.", 429);
  opening++;
  try {
    const [, repository, number] = match;
    const endpoint = `repos/${repository}/pulls/${number}`;
    const pr = await github(endpoint);
    validateSnapshot(pr);
    const records = new Map();
    let bytes = 0;
    for (let page = 1; records.size < pr.changed_files; page++) {
      const files = await github(`${endpoint}/files?per_page=100&page=${page}`);
      if (!Array.isArray(files) || !files.length)
        throw new RequestError("GitHub returned an incomplete file list. Reload the PR.", 409);
      bytes += Buffer.byteLength(JSON.stringify(files));
      if (bytes > snapshotLimit)
        throw new RequestError(
          "This hosted diff exceeds the 8 MB snapshot limit. Open it on GitHub.",
          422,
        );
      for (const file of files) {
        if (
          typeof file.filename !== "string" ||
          !/^[a-f0-9]{40}$/.test(file.sha) ||
          records.has(file.filename)
        )
          throw new RequestError("The PR's file list changed or is invalid. Reload the PR.", 409);
        records.set(file.filename, file);
      }
    }
    const latest = await github(endpoint);
    if (
      latest.head?.sha !== pr.head.sha ||
      latest.base?.sha !== pr.base.sha ||
      latest.changed_files !== pr.changed_files ||
      records.size !== pr.changed_files
    )
      throw new RequestError(
        "The pull request changed while loading. Reload it to review a consistent snapshot.",
        409,
      );
    const statuses = {
      added: "A",
      removed: "D",
      modified: "M",
      renamed: "R",
      copied: "C",
      changed: "T",
      unchanged: "M",
    };
    const files = [...records.values()].map((file) => ({
      path: file.filename,
      status: statuses[file.status] ?? "M",
      oldPath: file.previous_filename,
    }));
    const sources = new Map();
    const hosted = {
      repository,
      patch(file) {
        return patchFor(records.get(file.path));
      },
      async source(file) {
        const record = records.get(file.path);
        // File API blob IDs identify the returned side, including deleted files.
        // Gitlink/submodule SHAs are commits; GitHub then rejects the blob read.
        if (sources.has(record.sha)) return sources.get(record.sha);
        const task = github(`repos/${repository}/git/blobs/${record.sha}`).then((blob) => {
          if (
            blob.encoding !== "base64" ||
            typeof blob.content !== "string" ||
            !Number.isSafeInteger(blob.size)
          )
            throw new RequestError("GitHub did not return a text blob for this file.", 422);
          if (blob.size > displayLimit)
            throw new RequestError("This file exceeds the 400 KB display limit.", 422);
          const content = Buffer.from(blob.content, "base64");
          if (content.length !== blob.size)
            throw new RequestError("GitHub returned an incomplete file.", 502);
          const source = content.toString("utf8");
          if (source.includes("\0")) throw new RequestError("This is a binary file.", 422);
          return source;
        });
        // Coalesce only active reads; retaining every source would multiply the snapshot budget.
        sources.set(record.sha, task);
        try {
          return await task;
        } finally {
          sources.delete(record.sha);
        }
      },
    };
    const canonicalUrl = `https://github.com/${repository}/pull/${number}`;
    const label = `#${number} · ${pr.title}`;
    return {
      worktree: { path: "", repo: repository, branch: pr.head.ref, hosted: true },
      base: { sha: pr.base.sha, label: pr.base.ref },
      head: pr.head.sha,
      refs: [],
      files,
      live: false,
      canOpenFiles: false,
      pr: { base: pr.base.sha, head: pr.head.sha, label, url: canonicalUrl },
      hosted,
    };
  } finally {
    opening--;
  }
}
