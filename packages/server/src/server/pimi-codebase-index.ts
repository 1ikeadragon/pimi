// Pimi addition to the Paseo fork. Apache-2.0.
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { setImmediate } from "node:timers/promises";
import { createRunGitCommand } from "../utils/run-git-command.js";
import { loadSpacesEmbedder, type SpacesEmbedder } from "./pimi-spaces-embeddings.js";

// Limits bound daemon memory and cold-index work. Budget omissions are reported
// as partial, never presented as an exhaustive search of the workspace.
const MAX_WORKSPACES = 2;
const MAX_FILES = 6_000;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_CHUNKS = 12_000;
const MAX_INVENTORY_BYTES = 2 * 1024 * 1024;
const MAX_CHUNK_CHARS = 1_000;
const MAX_QUEUED = 8;
// Low positive cosine scores occur even for unrelated code with this model.
const MIN_SEMANTIC_SIMILARITY = 0.25;
const runGit = createRunGitCommand("pimi-codebase-index");
const GENERATED_DIRECTORIES = [
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  "generated",
  "__generated__",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  ".cache",
  ".turbo",
  ".dev",
  "release-pimi",
  "artifacts",
];

interface Chunk {
  startLine: number;
  endLine: number;
  excerpt: string;
  normalized: string;
  vector: Float32Array | null;
}
interface Entry {
  fingerprint: string;
  bytes: number;
  chunks: Chunk[];
}
interface Index {
  entries: Map<string, Entry>;
}
export interface PimiCodebaseSearchResult {
  mode: "hybrid" | "keyword";
  filesIndexed: number;
  chunksIndexed: number;
  partial: boolean;
  results: Array<{ path: string; startLine: number; endLine: number; excerpt: string }>;
}

const indexes = new Map<string, Index>();
let embedderPromise: Promise<SpacesEmbedder | null> | undefined;
let queue: Promise<unknown> = Promise.resolve();
let queued = 0;

/** Searches exactly cwd, including when it is a subdirectory of a Git worktree. */
export async function searchPimiCodebase(
  cwd: string,
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<PimiCodebaseSearchResult> {
  if (!query.trim() || query.length > 512) throw new Error("Use a query of 1–512 characters.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 30)
    throw new Error("Search limit must be 1–30.");
  signal?.throwIfAborted();
  if (queued >= MAX_QUEUED) throw new Error("Codebase search is busy; try again shortly.");
  const lifetime = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(45_000)]);
  queued++;
  // Serialize cold indexing across workspaces, avoiding simultaneous embedding
  // passes and bounding live cache memory even during eviction.
  const work = queue.then(async () => {
    lifetime.throwIfAborted();
    const root = await realpath(cwd);
    lifetime.throwIfAborted();
    return searchWorkspace(root, query.trim(), limit, lifetime);
  });
  queue = work.catch(() => undefined);
  try {
    return await work;
  } finally {
    queued--;
  }
}

async function inventory(root: string, signal: AbortSignal) {
  const options = {
    cwd: root,
    signal,
    timeout: 10_000,
    maxOutputBytes: MAX_INVENTORY_BYTES,
    envOverlay: {
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_LAZY_FETCH: "1",
      GIT_ALLOW_PROTOCOL: "",
      GIT_DIR: undefined,
      GIT_WORK_TREE: undefined,
      GIT_COMMON_DIR: undefined,
      LC_ALL: "C",
    },
  };
  const repository = await runGit(["rev-parse", "--is-inside-work-tree"], {
    ...options,
    acceptExitCodes: [0, 128],
  });
  if (repository.exitCode !== 0 || repository.stdout.trim() !== "true")
    throw new Error("Codebase search requires a directory inside a Git worktree.");
  const listed = await runGit(
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    options,
  );
  const denied = new Set<string>();
  const pruned = GENERATED_DIRECTORIES.map((directory) => `--exclude=${directory}/`);
  // Git has one per-directory ignore filename: repeated flags replace it.
  // Evaluate each policy separately, also excluding tracked ignored files.
  for (const policy of [
    "--exclude-standard",
    "--exclude-per-directory=.pimiignore",
    "--exclude-per-directory=.cursorignore",
  ]) {
    const ignored = await runGit(
      ["ls-files", "-z", "--cached", "--others", "--ignored", "--directory", policy, ...pruned],
      options,
    );
    if (ignored.truncated) return { paths: [] as string[], partial: true };
    for (const path of ignored.stdout.split("\0")) denied.add(path);
  }
  const complete = listed.stdout.slice(0, listed.stdout.lastIndexOf("\0") + 1);
  const candidates = [...new Set(complete.split("\0"))]
    .filter((path) => path && !isDenied(path, denied) && allowedPath(path))
    .sort();
  return {
    paths: spreadAcrossDirectories(candidates).slice(0, MAX_FILES),
    partial: listed.truncated || candidates.length > MAX_FILES,
  };
}

function spreadAcrossDirectories(paths: string[]): string[] {
  // A large package should not take the entire index budget before its siblings.
  const nextPosition = new Map<string, number>();
  return paths
    .map((path) => {
      const directory = dirname(path).split("/").slice(0, 2).join("/");
      const position = nextPosition.get(directory) ?? 0;
      nextPosition.set(directory, position + 1);
      return { path, position };
    })
    .sort((left, right) => left.position - right.position)
    .map(({ path }) => path);
}

function isDenied(path: string, denied: Set<string>): boolean {
  if (denied.has(path)) return true;
  for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
    if (denied.has(path.slice(0, slash + 1))) return true;
  }
  return false;
}

function allowedPath(path: string): boolean {
  if (isAbsolute(path) || path.split("/").includes("..") || path.includes("\\")) return false;
  const parts = path.toLowerCase().split("/");
  const name = parts.at(-1)!;
  const excludedDirectory =
    /^(?:\.git|\.hg|\.svn|\.ssh|\.aws|\.azure|\.gnupg|\.docker|\.kube|secrets|credentials)$/;
  if (parts.some((part) => GENERATED_DIRECTORIES.includes(part) || excludedDirectory.test(part)))
    return false;
  if (
    /^(?:\.env.*|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|service[-_]account.*\.json|.*\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/.test(
      name,
    )
  )
    return false;
  if (
    /\.(?:pem|key|p12|pfx|jks|keystore|crt|cer|map|min\.[^.]+|generated\.[^.]+|g\.cs)$/.test(name)
  )
    return false;
  return (
    /\.(?:[cm]?[jt]sx?|py|pyi|rs|go|java|kt|kts|c|h|cpp|hpp|cc|cs|swift|m|mm|rb|php|lua|sh|bash|zsh|fish|sql|graphql|gql|proto|vue|svelte|html?|css|scss|sass|less|md|mdx|rst|txt|json|jsonc|ya?ml|toml|ini|cfg|conf|xml|ex|exs|erl|hrl|hs|clj|cljs|scala|r|dart|zig|tf|nix|cmake)$/.test(
      name,
    ) ||
    /^(?:dockerfile(?:\..*)?|makefile|gnumakefile|justfile|gemfile|rakefile|procfile|cmakelists\.txt|\.editorconfig)$/.test(
      name,
    )
  );
}

/** Never walk a symlink component or enter a nested repository/submodule. */
async function scopedFile(root: string, path: string, directories: Map<string, boolean>) {
  const full = join(root, path);
  let directory = dirname(full);
  const chain: string[] = [];
  while (directory !== root) {
    const rel = relative(root, directory);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    chain.push(directory);
    directory = dirname(directory);
  }
  for (const part of chain.toReversed()) {
    let safe = directories.get(part);
    if (safe === undefined) {
      const info = await lstat(part);
      safe = info.isDirectory() && !info.isSymbolicLink();
      if (safe) safe = !(await hasGitMarker(part));
      directories.set(part, safe);
    }
    if (!safe) return null;
  }
  const stat = await lstat(full, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  // Check canonical identity again before opening; O_NOFOLLOW protects the leaf.
  if ((await realpath(full)) !== full) return null;
  return {
    path,
    full,
    stat,
    fingerprint: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
  };
}

async function hasGitMarker(directory: string): Promise<boolean> {
  try {
    await lstat(join(directory, ".git"));
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function normalizeCode(text: string): string {
  return text
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_./-]+/g, " ")
    .toLowerCase();
}

function privateOrGenerated(text: string): boolean {
  return (
    /-----BEGIN (?:[A-Z ]*PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|glpat-[A-Za-z0-9_-]{20,})\b/.test(
      text,
    ) ||
    /(?:@generated|automatically generated|auto-generated|generated file|do not edit)/i.test(
      text.slice(0, 2_048),
    )
  );
}

async function readEntry(
  file: NonNullable<Awaited<ReturnType<typeof scopedFile>>>,
  embedder: SpacesEmbedder | null,
  signal: AbortSignal,
): Promise<Entry | null> {
  const handle = await open(
    file.full,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (
      `${before.dev}:${before.ino}:${before.size}:${before.mtimeNs}:${before.ctimeNs}` !==
      file.fingerprint
    )
      return null;
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      signal.throwIfAborted();
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      length !== Number(before.size) ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    )
      return null;
    const bytes = buffer.subarray(0, length);
    if (bytes.includes(0)) return null;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
    if (privateOrGenerated(text)) return null;
    return {
      fingerprint: file.fingerprint,
      bytes: length,
      chunks: await chunkText(text, file.path, embedder, signal),
    };
  } finally {
    await handle.close();
  }
}

async function chunkText(
  text: string,
  path: string,
  embedder: SpacesEmbedder | null,
  signal: AbortSignal,
): Promise<Chunk[]> {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const chunks: Chunk[] = [];
  for (let start = 0; start < lines.length; ) {
    signal.throwIfAborted();
    let end = start;
    let length = 0;
    while (
      end < lines.length &&
      end - start < 30 &&
      (length === 0 || length + lines[end].length + 1 <= MAX_CHUNK_CHARS)
    ) {
      length += lines[end].length + 1;
      end++;
    }
    const excerpt = lines.slice(start, end).join("\n");
    // Very long lines are split without inventing line numbers or dropping text.
    for (let offset = 0; offset < excerpt.length; offset += MAX_CHUNK_CHARS) {
      const slice = excerpt.slice(offset, offset + MAX_CHUNK_CHARS);
      if (!slice.trim()) continue;
      const normalized = normalizeCode(slice);
      chunks.push({
        startLine: start + 1,
        endLine: end,
        excerpt: slice,
        normalized,
        vector: embedder?.embed(`${normalizeCode(path)}\n${normalized}`) ?? null,
      });
      if (chunks.length % 8 === 0) {
        await setImmediate();
        signal.throwIfAborted();
      }
    }
    if (end === lines.length) break;
    start = Math.max(start + 1, end - 3);
  }
  return chunks;
}

async function searchWorkspace(
  root: string,
  query: string,
  limit: number,
  signal: AbortSignal,
): Promise<PimiCodebaseSearchResult> {
  const listing = await inventory(root, signal);
  const embedder = await (embedderPromise ??= loadSpacesEmbedder().catch(() => null));
  let index = indexes.get(root);
  indexes.delete(root);
  if (!index) index = { entries: new Map() };
  while (indexes.size >= MAX_WORKSPACES) indexes.delete(indexes.keys().next().value!);
  indexes.set(root, index);
  const next = new Map<string, Entry>();
  const previousEntries = index.entries;
  // Completed files survive cancellation, so the next search can resume a cold
  // index without repeating embeddings. Omitted/stale files are never returned.
  index.entries = next;
  const directories = new Map<string, boolean>();
  let bytes = 0;
  let chunks = 0;
  let partial = listing.partial;
  for (const path of listing.paths) {
    signal.throwIfAborted();
    try {
      const file = await scopedFile(root, path, directories);
      if (!file) continue;
      if (
        file.stat.size > MAX_FILE_BYTES ||
        bytes + Number(file.stat.size) > MAX_TOTAL_BYTES ||
        chunks >= MAX_CHUNKS
      ) {
        partial = true;
        continue;
      }
      const previous = previousEntries.get(path);
      const entry =
        previous?.fingerprint === file.fingerprint
          ? previous
          : await readEntry(file, embedder, signal);
      if (!entry) continue;
      if (chunks + entry.chunks.length > MAX_CHUNKS) {
        partial = true;
        continue;
      }
      next.set(path, entry);
      bytes += entry.bytes;
      chunks += entry.chunks.length;
    } catch (error) {
      signal.throwIfAborted();
      // Unreadable/changing entries do not poison the cache or expose old text.
      if (!isMissing(error)) partial = true;
    }
    await setImmediate();
  }
  index.entries = next;
  const vector = embedder?.embed(normalizeCode(query)) ?? null;
  const results = await rank(next, query, vector, limit, signal);
  return {
    mode: vector ? "hybrid" : "keyword",
    filesIndexed: next.size,
    chunksIndexed: chunks,
    partial,
    results,
  };
}

async function rank(
  entries: Map<string, Entry>,
  query: string,
  vector: Float32Array | null,
  limit: number,
  signal: AbortSignal,
) {
  const words = /[\p{L}\p{N}]+/gu;
  const terms = [...new Set(normalizeCode(query).match(words))];
  const exact = query.toLowerCase();
  const matches: Array<{ score: number; path: string; chunk: Chunk }> = [];
  let visited = 0;
  for (const [path, entry] of entries) {
    const normalizedPath = normalizeCode(path);
    for (const chunk of entry.chunks) {
      const tokens = new Set(`${normalizedPath}\n${chunk.normalized}`.match(words));
      const hits = terms.filter((term) => tokens.has(term)).length;
      const literal = `${path}\n${chunk.excerpt}`.toLowerCase().includes(exact);
      let similarity = 0;
      if (vector && chunk.vector)
        for (let i = 0; i < vector.length; i++) similarity += vector[i] * chunk.vector[i];
      const lexicalMatch = hits > 0 && (!vector || hits >= Math.min(2, terms.length));
      if (literal || lexicalMatch || similarity >= MIN_SEMANTIC_SIMILARITY) {
        const score =
          Number(literal) * 2 +
          Number(hits > 0 && hits === terms.length) +
          (terms.length ? hits / terms.length : 0) * 0.25 +
          Math.max(0, similarity);
        matches.push({ score, path, chunk });
      }
      if (++visited % 128 === 0) {
        await setImmediate();
        signal.throwIfAborted();
      }
    }
  }
  matches.sort(
    (left, right) =>
      right.score - left.score ||
      left.path.localeCompare(right.path) ||
      left.chunk.startLine - right.chunk.startLine,
  );
  const results: PimiCodebaseSearchResult["results"] = [];
  for (const match of matches) {
    if (
      results.some(
        (item) =>
          item.path === match.path &&
          item.startLine <= match.chunk.endLine &&
          item.endLine >= match.chunk.startLine,
      )
    )
      continue;
    const { startLine, endLine, excerpt } = match.chunk;
    results.push({ path: match.path, startLine, endLine, excerpt });
    if (results.length === limit) break;
  }
  return results;
}
