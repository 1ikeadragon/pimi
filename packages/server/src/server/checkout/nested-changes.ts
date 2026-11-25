/**
 * Changes for a folder that holds many Git repositories and linked worktrees.
 *
 * A chat can be opened on a plain folder such as `~/research`. The folder is not a checkout, so the
 * workspace Git pipeline has nothing to report. This module finds the repositories below it
 * (bounded walk), reads one `git status --porcelain=v2` per repository, and keeps those results
 * fresh for the clients that subscribed to the folder.
 *
 * Every Git process goes through `runGitCommand`, so the shared GitProcessScheduler (rate and
 * concurrency policy) still applies. This module adds a smaller concurrency of its own so a
 * 200-repository refresh cannot occupy the whole pool.
 *
 * Freshness is layered, cheapest signal first:
 * - HEAD and index files of every repository, through the single-file observer (staging, commit,
 *   checkout).
 * - A recursive working-tree watch, only for repositories a client asked to watch (expanded groups).
 * - Turn end of an agent whose directory overlaps the folder.
 * - A poll while a client is subscribed. It is the only signal for working-tree edits made in a
 *   repository nobody is watching, which is why each repository carries `checkedAt` and the UI shows
 *   its age.
 * - An explicit refresh.
 */

import { constants } from "node:fs";
import { lstat, open, readdir, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import pLimit from "p-limit";
import type pino from "pino";
import { getErrorMessage } from "@pimi/protocol/error-utils";
import {
  MAX_NESTED_CHANGED_FILES,
  MAX_WATCHED_NESTED_CHECKOUTS,
  type NestedChangedFile,
  type NestedChangesRepository,
  type NestedFileState,
} from "@pimi/protocol/messages";
import { DEFAULT_GIT_PROCESS_POLICY } from "../../utils/git-process-scheduler.js";
import { runGitCommand, type RunGitCommand } from "../../utils/run-git-command.js";
import {
  WORKSPACE_GIT_AUXILIARY_READ_TTL_MS,
  WORKSPACE_GIT_INTERNAL_MIN_GAP_MS,
  WORKSPACE_GIT_WATCHER_SUBSCRIBE_TIMEOUT_MS,
} from "../workspace-git-service.js";

// ---
// Constants

/** Repositories listed for one folder. The most recently used win; the rest set `truncated`. */
export const MAX_NESTED_CHECKOUTS = 200;

/**
 * Directories examined by one discovery walk. A folder such as the home directory has far more
 * directories than repositories at depth 3; at ~16 concurrent lstat/readdir probes this bounds a
 * walk to a few seconds. Judgement call, not measured on every filesystem.
 */
const MAX_SCANNED_DIRECTORIES = 10_000;

/**
 * Status output is read in full before it is parsed, so it needs its own ceiling: the file cap times
 * PATH_MAX (4096) covers 500 entries made of maximum-length paths. Output that still exceeds it is
 * cut by the Git runner and reported as `truncated`.
 */
const NESTED_STATUS_MAX_OUTPUT_BYTES = MAX_NESTED_CHANGED_FILES * 4096;

/** Half the shared Git process pool, so folder refreshes leave room for everything else. */
export const NESTED_STATUS_CONCURRENCY = Math.max(
  1,
  Math.floor(DEFAULT_GIT_PROCESS_POLICY.maxProcessConcurrency / 2),
);

/** One repository's status may not hold a slot longer than a watcher subscription may take. */
const NESTED_STATUS_TIMEOUT_MS = WORKSPACE_GIT_WATCHER_SUBSCRIBE_TIMEOUT_MS;

/** Poll interval while a client is subscribed. Same freshness the auxiliary Git reads accept. */
export const NESTED_VISIBLE_POLL_MS = WORKSPACE_GIT_AUXILIARY_READ_TTL_MS;

/** Minimum time between two status runs of one repository, absorbing watcher bursts. */
export const NESTED_STATUS_MIN_GAP_MS = WORKSPACE_GIT_INTERNAL_MIN_GAP_MS;

/** Concurrent filesystem probes, shared by every discovery walk in the process. */
const PROBE_CONCURRENCY = 16;
const nestedProbeLimit = pLimit(PROBE_CONCURRENCY);

const MAX_GIT_POINTER_BYTES = 1024;
const MAX_GITMODULES_BYTES = 64 * 1024;

/**
 * Dot-directories that hold linked worktrees. Every other dot-directory is skipped by the walk.
 * Hardcoded to the layouts Pimi and Claude Code create (`.worktrees/<name>`,
 * `.claude/worktrees/<name>`); a container counts as one level of depth whatever its segment count.
 */
const WORKTREE_CONTAINERS: readonly string[] = [".worktrees", ".claude/worktrees"];

const SKIPPED_DIRECTORY_NAMES: ReadonlySet<string> = new Set(["node_modules"]);

// ---
// Types

export interface DiscoveredRepository {
  root: string;
  name: string;
  gitDir: string;
  isWorktree: boolean;
  usedAt: number;
  /**
   * Repositories found inside this one (submodules, linked worktrees, nested clones), as paths
   * relative to root. Their rows are dropped from this repository's status: each is its own group.
   */
  childPaths: string[];
}

export interface NestedDiscovery {
  repositories: DiscoveredRepository[];
  truncated: boolean;
}

// ---
// Discovery

async function readSmallFile(path: string, maxBytes: number): Promise<string> {
  // Non-blocking so a FIFO cannot stall the scan; only a regular file is read.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new Error(`${path} is not a file`);
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await file.read(buffer, 0, maxBytes, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await file.close();
  }
}

interface CheckoutProbe {
  gitDir: string;
  isWorktree: boolean;
  usedAt: number;
}

/**
 * Whether `path` is a Git checkout, and when it was last used: its index's modified time, which Git
 * rewrites on add, commit and checkout. A linked worktree's or submodule's `.git` file points at the
 * directory holding its index. Null when `path` is not a checkout (also when it cannot be read: a
 * directory the walk may not enter is not a repository to list).
 */
export async function probeCheckout(path: string): Promise<CheckoutProbe | null> {
  const dotGit = join(path, ".git");
  let gitDir = dotGit;
  try {
    if ((await lstat(dotGit)).isFile()) {
      const pointer = /^gitdir: (.+)$/m
        .exec(await readSmallFile(dotGit, MAX_GIT_POINTER_BYTES))?.[1]
        ?.trim();
      if (!pointer) return null;
      gitDir = resolve(path, pointer);
    }
  } catch {
    return null;
  }
  // A Git directory has HEAD, and its repository (a linked worktree's lives in commondir) has
  // objects; an empty, unrelated or orphaned folder lacks one of them.
  if (!(await stat(join(gitDir, "HEAD")).catch(() => null))?.isFile()) return null;
  const commonDir = await readSmallFile(join(gitDir, "commondir"), MAX_GIT_POINTER_BYTES).then(
    (pointer) => resolve(gitDir, pointer.trim()),
    () => null,
  );
  const repositoryDir = commonDir ?? gitDir;
  if (!(await stat(join(repositoryDir, "objects")).catch(() => null))?.isDirectory()) return null;
  const index = await stat(join(gitDir, "index")).catch(() => null);
  // A repository with nothing staged yet has no index.
  const usedAt = index?.mtimeMs ?? (await stat(gitDir).catch(() => null))?.mtimeMs ?? null;
  if (usedAt === null) return null;
  return { gitDir, isWorktree: commonDir !== null, usedAt };
}

async function listSubdirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (isMissingOrNotDirectory(error)) return [];
    throw error;
  }
}

function isMissingOrNotDirectory(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

/** Submodule paths declared by a repository's `.gitmodules`; a missing file declares none. */
async function readSubmodulePaths(repositoryRoot: string): Promise<string[]> {
  let text: string;
  try {
    text = await readSmallFile(join(repositoryRoot, ".gitmodules"), MAX_GITMODULES_BYTES);
  } catch (error) {
    if (isMissingOrNotDirectory(error)) return [];
    throw error;
  }
  const paths: string[] = [];
  for (const match of text.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)) {
    const declared = match[1];
    if (declared && !isAbsolute(declared) && !declared.split(/[\\/]/).includes("..")) {
      paths.push(declared);
    }
  }
  return paths;
}

/**
 * Finds the Git checkouts at most `depth` directory levels below `folder` (the folder itself when it
 * is a checkout), most recently used first. Descends only through plain directories: a checkout is
 * not entered except for its worktree containers and its declared submodules, so a repository's own
 * tree is never walked. Does not run Git.
 */
export async function discoverNestedRepositories(
  folder: string,
  options: { depth: number; signal?: AbortSignal },
): Promise<NestedDiscovery> {
  const root = resolve(folder);
  // A missing folder is an error for the caller, unlike a missing worktree container below it.
  if (!(await stat(root)).isDirectory()) throw new Error(`${root} is not a directory`);
  const found = new Map<string, DiscoveredRepository>();
  let scanned = 0;
  let scanTruncated = false;

  const nameOf = (path: string) => relative(root, path).split(sep).join("/") || basename(root);

  const probe = async (path: string): Promise<CheckoutProbe | null> => {
    options.signal?.throwIfAborted();
    if (scanned >= MAX_SCANNED_DIRECTORIES) {
      scanTruncated = true;
      return null;
    }
    scanned += 1;
    return nestedProbeLimit(() => probeCheckout(path));
  };

  async function visitRepository(
    path: string,
    probed: CheckoutProbe,
    level: number,
  ): Promise<void> {
    if (found.has(path)) return;
    const repository: DiscoveredRepository = {
      root: path,
      name: nameOf(path),
      gitDir: probed.gitDir,
      isWorktree: probed.isWorktree,
      usedAt: probed.usedAt,
      childPaths: [],
    };
    found.set(path, repository);
    const children: Promise<void>[] = [];
    for (const declared of await nestedProbeLimit(() => readSubmodulePaths(path))) {
      const submodule = join(path, declared);
      children.push(visitSubmodule(submodule, level + 1));
    }
    // A container is one level, so `repo/.worktrees/x` is at depth 3 whatever the container's name.
    if (level + 2 <= options.depth) {
      for (const container of WORKTREE_CONTAINERS) {
        children.push(visitWorktreeContainer(join(path, container), level + 2));
      }
    }
    await Promise.all(children);
  }

  async function visitSubmodule(path: string, level: number): Promise<void> {
    const probed = await probe(path);
    if (probed) await visitRepository(path, probed, level);
  }

  async function visitWorktreeContainer(container: string, level: number): Promise<void> {
    const names = await nestedProbeLimit(() => listSubdirectories(container));
    await Promise.all(
      names.map(async (name) => {
        const path = join(container, name);
        const probed = await probe(path);
        if (probed) await visitRepository(path, probed, level);
      }),
    );
  }

  async function visitDirectory(path: string, level: number): Promise<void> {
    const probed = await probe(path);
    if (probed) {
      await visitRepository(path, probed, level);
      return;
    }
    if (level >= options.depth) return;
    const names = await nestedProbeLimit(() => listSubdirectories(path));
    await Promise.all(
      names
        .filter((name) => !name.startsWith(".") && !SKIPPED_DIRECTORY_NAMES.has(name))
        .map((name) => visitDirectory(join(path, name), level + 1)),
    );
  }

  const rootProbe = await probe(root);
  if (rootProbe) await visitRepository(root, rootProbe, 0);
  else {
    // The folder's own worktree containers hold checkouts too, one level below it like any child.
    if (options.depth >= 1) {
      await Promise.all(
        WORKTREE_CONTAINERS.map((container) => visitWorktreeContainer(join(root, container), 1)),
      );
    }
    const names = await listSubdirectories(root);
    await Promise.all(
      names
        .filter((name) => !name.startsWith(".") && !SKIPPED_DIRECTORY_NAMES.has(name))
        .map((name) => visitDirectory(join(root, name), 1)),
    );
  }

  const sorted = [...found.values()].sort((a, b) => b.usedAt - a.usedAt);
  const listed = sorted.slice(0, MAX_NESTED_CHECKOUTS);
  for (const repository of listed) {
    repository.childPaths = listed
      .filter((other) => other !== repository && isWithin(repository.root, other.root))
      .map((other) => relative(repository.root, other.root).split(sep).join("/"));
  }
  return {
    repositories: listed,
    truncated: scanTruncated || sorted.length > MAX_NESTED_CHECKOUTS,
  };
}

// ---
// Status

function stateFromCode(code: string): NestedFileState | null {
  switch (code) {
    case "M":
    case "T":
      return "modified";
    case "A":
    case "C":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "U":
      return "conflicted";
    default:
      return null;
  }
}

export interface ParsedStatus {
  branch: string | null;
  ahead: number;
  behind: number;
  files: NestedChangedFile[];
  /** More entries existed than MAX_NESTED_CHANGED_FILES. */
  overflowed: boolean;
}

/**
 * Parses `git status --porcelain=v2 --branch -z`. A path changed in both index and working tree
 * yields two entries (staged and not). `childPaths` are repositories of their own below this one
 * (relative, no trailing slash). Git reports a submodule as a gitlink row and a nested clone or
 * linked worktree as an untracked directory; both rows are dropped so a change is not shown twice.
 */
export function parsePorcelainV2Status(
  output: string,
  childPaths: ReadonlySet<string> = new Set(),
): ParsedStatus {
  const result: ParsedStatus = { branch: null, ahead: 0, behind: 0, files: [], overflowed: false };
  const records = output.split("\0");
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (!record) continue;
    // A rename's original path is the next NUL-separated record.
    const oldPath = record[0] === "2" ? records[++i] : undefined;
    const entries = record.startsWith("# ")
      ? readBranchHeader(record, result)
      : readChangeEntries(record, oldPath, childPaths);
    for (const entry of entries) {
      if (result.files.length >= MAX_NESTED_CHANGED_FILES) result.overflowed = true;
      else result.files.push(entry);
    }
  }
  return result;
}

function readBranchHeader(record: string, result: ParsedStatus): NestedChangedFile[] {
  const [, key, ...rest] = record.split(" ");
  const value = rest.join(" ");
  if (key === "branch.head") {
    result.branch = value === "(detached)" ? null : value;
  } else if (key === "branch.ab") {
    result.ahead = Number(/\+(\d+)/.exec(value)?.[1] ?? 0);
    result.behind = Number(/-(\d+)/.exec(value)?.[1] ?? 0);
  }
  return [];
}

function readChangeEntries(
  record: string,
  oldPath: string | undefined,
  childPaths: ReadonlySet<string>,
): NestedChangedFile[] {
  switch (record[0]) {
    case "?": {
      const path = record.slice(2);
      return childPaths.has(path.replace(/\/$/, ""))
        ? []
        : [{ path, state: "untracked", staged: false }];
    }
    case "u": {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const fields = splitFields(record, 10);
      return fields ? [{ path: fields.path, state: "conflicted", staged: false }] : [];
    }
    case "1":
    case "2": {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path> NUL <origPath>
      const fields = splitFields(record, record[0] === "1" ? 8 : 9);
      if (!fields) return [];
      const [, xy = "", submodule = ""] = fields.head;
      if (submodule.startsWith("S") && childPaths.has(fields.path)) return [];
      const entries: NestedChangedFile[] = [];
      const staged = stateFromCode(xy[0] ?? "");
      const unstaged = stateFromCode(xy[1] ?? "");
      if (staged) {
        entries.push({
          path: fields.path,
          ...(staged === "renamed" && oldPath ? { oldPath } : {}),
          state: staged,
          staged: true,
        });
      }
      if (unstaged) entries.push({ path: fields.path, state: unstaged, staged: false });
      return entries;
    }
    default:
      return [];
  }
}

/** Splits a record into `count` space-separated fields followed by a path that may contain spaces. */
function splitFields(record: string, count: number): { head: string[]; path: string } | null {
  const head: string[] = [];
  let from = 0;
  for (let n = 0; n < count; n += 1) {
    const space = record.indexOf(" ", from);
    if (space === -1) return null;
    head.push(record.slice(from, space));
    from = space + 1;
  }
  return { head, path: record.slice(from) };
}

export async function readRepositoryChanges(
  repository: Pick<DiscoveredRepository, "root" | "name" | "isWorktree" | "childPaths">,
  options: { runGit?: RunGitCommand; now?: () => number; signal?: AbortSignal } = {},
): Promise<NestedChangesRepository> {
  const runGit = options.runGit ?? runGitCommand;
  const now = options.now ?? Date.now;
  const base = {
    root: repository.root,
    name: repository.name,
    isWorktree: repository.isWorktree,
  };
  try {
    const result = await runGit(
      [
        "status",
        "--porcelain=v2",
        "--branch",
        "-z",
        "--untracked-files=all",
        // The submodule's own group reports its working tree; the parent keeps only a moved pointer.
        "--ignore-submodules=dirty",
      ],
      {
        cwd: repository.root,
        signal: options.signal,
        timeout: NESTED_STATUS_TIMEOUT_MS,
        maxOutputBytes: NESTED_STATUS_MAX_OUTPUT_BYTES,
        // status refreshes the index by default; a read-only observer must not rewrite it, which
        // would also fire this module's own index observer.
        envOverlay: { GIT_OPTIONAL_LOCKS: "0" },
      },
    );
    const parsed = parsePorcelainV2Status(result.stdout, new Set(repository.childPaths));
    return {
      ...base,
      branch: parsed.branch,
      ahead: parsed.ahead,
      behind: parsed.behind,
      files: parsed.files,
      truncated: parsed.overflowed || result.truncated,
      error: null,
      checkedAt: now(),
    };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return {
      ...base,
      branch: null,
      ahead: 0,
      behind: 0,
      files: [],
      truncated: false,
      error: getErrorMessage(error),
      checkedAt: now(),
    };
  }
}

// ---
// Service

export interface NestedChangesUpdate {
  /** Repositories whose result changed or was re-checked since the previous update. */
  repositories: NestedChangesRepository[];
  /** Roots that disappeared from the folder. */
  removed: string[];
  truncated: boolean;
}

export interface NestedChangesSnapshot {
  folder: string;
  repositories: NestedChangesRepository[];
  truncated: boolean;
}

export interface NestedChangesSubscription {
  readonly initial: NestedChangesSnapshot;
  /**
   * Replaces the repositories whose working tree is watched for this subscription. Roots are ordered
   * least to most recently expanded; only the last MAX_WATCHED_NESTED_CHECKOUTS are watched. Returns
   * the roots actually watched.
   */
  setWatchedRoots(roots: readonly string[]): Promise<string[]>;
  /**
   * Re-reads one repository, or re-discovers the folder and re-reads every repository when `root`
   * is null, ignoring the minimum gap. Resolves when the results were emitted.
   */
  refresh(root: string | null): Promise<void>;
  unsubscribe(): Promise<void>;
}

export interface NestedChangesDependencies {
  runGit?: RunGitCommand;
  /** Observes one file; the listener fires after it changed. */
  observeFile(input: { cwd: string; path: string }, listener: () => void): Promise<Unsubscribable>;
  /** Observes a repository's working tree recursively. */
  observeWorkingTree(root: string, listener: () => void): Promise<Unsubscribable>;
  logger: pino.Logger;
  now?: () => number;
}

interface Unsubscribable {
  unsubscribe(): void | Promise<void>;
}

interface RepositoryState {
  discovered: DiscoveredRepository;
  latest: NestedChangesRepository;
  fingerprint: string;
  fileObservers: Promise<Unsubscribable[]>;
  workingTreeWatchers: Map<Subscriber, Promise<Unsubscribable | null>>;
  running: Promise<void> | null;
  rerun: boolean;
  lastStartedAtMs: number;
  timer: NodeJS.Timeout | null;
}

interface Subscriber {
  onUpdate(update: NestedChangesUpdate): void;
  /** False until the snapshot was taken, so no update older than the snapshot reaches the client. */
  live: boolean;
  watched: string[];
}

interface FolderState {
  key: string;
  folder: string;
  depth: number;
  subscribers: Set<Subscriber>;
  repositories: Map<string, RepositoryState>;
  truncated: boolean;
  abort: AbortController;
  firstDiscovery: Promise<void> | null;
  pollTimer: NodeJS.Timeout | null;
  pass: Promise<void> | null;
  passQueued: boolean;
  closed: boolean;
}

export class NestedChangesService {
  private readonly folders = new Map<string, FolderState>();
  private readonly statusLimit = pLimit(NESTED_STATUS_CONCURRENCY);
  private readonly now: () => number;
  private readonly runGit: RunGitCommand;

  constructor(private readonly deps: NestedChangesDependencies) {
    this.now = deps.now ?? Date.now;
    this.runGit = deps.runGit ?? runGitCommand;
  }

  async subscribe(
    folderPath: string,
    options: { depth: number },
    onUpdate: (update: NestedChangesUpdate) => void,
  ): Promise<NestedChangesSubscription> {
    const folder = resolve(folderPath);
    // A different depth finds different repositories, so it is a different folder state.
    const key = `${options.depth}\0${folder}`;
    let state = this.folders.get(key);
    if (!state) {
      state = {
        key,
        folder,
        depth: options.depth,
        subscribers: new Set(),
        repositories: new Map(),
        truncated: false,
        abort: new AbortController(),
        firstDiscovery: null,
        pollTimer: null,
        pass: null,
        passQueued: false,
        closed: false,
      };
      this.folders.set(key, state);
    }
    const subscriber: Subscriber = { onUpdate, live: false, watched: [] };
    const folderState = state;
    folderState.subscribers.add(subscriber);
    try {
      folderState.firstDiscovery ??= this.discover(folderState);
      await folderState.firstDiscovery;
      if (folderState.closed) throw new Error(`Nested changes for ${folder} were closed`);
    } catch (error) {
      folderState.firstDiscovery = null;
      await this.removeSubscriber(folderState, subscriber);
      throw error;
    }
    const initial = this.snapshot(folderState);
    subscriber.live = true;
    // The first statuses stream in as updates; the snapshot returns as soon as the list is known.
    this.startPass(folderState, { discover: false, force: true });
    this.armPoll(folderState);

    let released = false;
    return {
      initial,
      setWatchedRoots: (roots) => this.setWatchedRoots(folderState, subscriber, roots),
      refresh: async (root) => {
        if (root === null) {
          await this.runPass(folderState, { discover: true, force: true });
          return;
        }
        const repository = folderState.repositories.get(resolve(root));
        if (!repository) throw new Error(`${root} is not a repository in ${folderState.folder}`);
        await this.scheduleRepository(folderState, repository, { force: true });
      },
      unsubscribe: async () => {
        if (released) return;
        released = true;
        await this.removeSubscriber(folderState, subscriber);
      },
    };
  }

  /**
   * An agent turn ended, or a Git operation may have changed state, in `cwd`. Refreshes the
   * repository that contains it, or every repository when it is the folder (or an ancestor).
   */
  noteWorkspaceStateMayHaveChanged(cwd: string): void {
    const target = resolve(cwd);
    for (const state of this.folders.values()) {
      if (state.closed) continue;
      const owner = this.owningRepository(state, target);
      if (owner) this.scheduleRepository(state, owner, { force: false });
      else if (isWithin(state.folder, target) || isWithin(target, state.folder)) {
        this.startPass(state, { discover: true, force: false });
      }
    }
  }

  /**
   * An agent finished an edit or write of `filePath` (absolute). Refreshes the repository that
   * contains it; the per-repository minimum gap keeps a burst of edits to one status per gap.
   */
  noteFileEdited(filePath: string): void {
    for (const state of this.folders.values()) {
      if (state.closed) continue;
      const owner = this.owningRepository(state, filePath);
      if (owner) this.scheduleRepository(state, owner, { force: false });
    }
  }

  private owningRepository(state: FolderState, path: string): RepositoryState | undefined {
    let owner: RepositoryState | undefined;
    for (const repository of state.repositories.values()) {
      if (!isWithin(repository.discovered.root, path)) continue;
      // The deepest root wins: a linked worktree lives inside its parent repository's folder.
      if (!owner || repository.discovered.root.length > owner.discovered.root.length) {
        owner = repository;
      }
    }
    return owner;
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.folders.values()].map((state) => this.closeFolder(state)));
  }

  // --- subscriptions

  private snapshot(state: FolderState): NestedChangesSnapshot {
    return {
      folder: state.folder,
      repositories: [...state.repositories.values()].map((repository) => repository.latest),
      truncated: state.truncated,
    };
  }

  private async removeSubscriber(state: FolderState, subscriber: Subscriber): Promise<void> {
    state.subscribers.delete(subscriber);
    await this.applyWatchedRoots(state, subscriber, []);
    if (state.subscribers.size === 0) await this.closeFolder(state);
  }

  private async closeFolder(state: FolderState): Promise<void> {
    if (state.closed) return;
    state.closed = true;
    state.abort.abort();
    if (this.folders.get(state.key) === state) this.folders.delete(state.key);
    if (state.pollTimer) clearTimeout(state.pollTimer);
    state.pollTimer = null;
    await Promise.all([...state.repositories.values()].map((repo) => this.teardown(state, repo)));
    state.repositories.clear();
  }

  // --- discovery and status

  private async discover(state: FolderState): Promise<void> {
    const discovery = await discoverNestedRepositories(state.folder, {
      depth: state.depth,
      signal: state.abort.signal,
    });
    if (state.closed) return;
    state.truncated = discovery.truncated;
    const present = new Set(discovery.repositories.map((repository) => repository.root));
    const removed: string[] = [];
    for (const [root, repository] of state.repositories) {
      if (present.has(root)) continue;
      removed.push(root);
      state.repositories.delete(root);
      await this.teardown(state, repository);
    }
    const added: NestedChangesRepository[] = [];
    for (const discovered of discovery.repositories) {
      const existing = state.repositories.get(discovered.root);
      if (existing) {
        existing.discovered = discovered;
        continue;
      }
      const repository = this.createRepositoryState(state, discovered);
      state.repositories.set(discovered.root, repository);
      added.push(repository.latest);
    }
    if (state.subscribers.size > 0 && (removed.length > 0 || added.length > 0)) {
      this.emit(state, { repositories: added, removed, truncated: state.truncated });
    }
  }

  private createRepositoryState(
    state: FolderState,
    discovered: DiscoveredRepository,
  ): RepositoryState {
    const repository: RepositoryState = {
      discovered,
      latest: {
        root: discovered.root,
        name: discovered.name,
        branch: null,
        isWorktree: discovered.isWorktree,
        ahead: 0,
        behind: 0,
        files: [],
        truncated: false,
        error: null,
        checkedAt: null,
      },
      fingerprint: "",
      fileObservers: Promise.resolve([]),
      workingTreeWatchers: new Map(),
      running: null,
      rerun: false,
      lastStartedAtMs: 0,
      timer: null,
    };
    repository.fileObservers = this.observeGitFiles(state, repository);
    return repository;
  }

  /** HEAD changes on checkout and branch switch; the index on staging, commit and reset. */
  private async observeGitFiles(
    state: FolderState,
    repository: RepositoryState,
  ): Promise<Unsubscribable[]> {
    const observed = await Promise.allSettled(
      ["HEAD", "index"].map((path) =>
        this.deps.observeFile({ cwd: repository.discovered.gitDir, path }, () =>
          this.scheduleRepository(state, repository, { force: false }),
        ),
      ),
    );
    const subscriptions: Unsubscribable[] = [];
    for (const result of observed) {
      if (result.status === "fulfilled") subscriptions.push(result.value);
      else {
        // Polling still covers this repository; the failure must not be invisible.
        this.deps.logger.warn(
          { err: result.reason, root: repository.discovered.root },
          "Could not observe a Git file of a nested repository",
        );
      }
    }
    return subscriptions;
  }

  private async teardown(state: FolderState, repository: RepositoryState): Promise<void> {
    if (repository.timer) clearTimeout(repository.timer);
    repository.timer = null;
    const watchers = [...repository.workingTreeWatchers.values()];
    repository.workingTreeWatchers.clear();
    const subscriptions = [
      ...(await repository.fileObservers),
      ...(await Promise.all(watchers)).filter((watcher) => watcher !== null),
    ];
    // The repository may already be gone from disk; one failing teardown must not leak the others.
    const results = await Promise.allSettled(
      subscriptions.map(async (subscription) => subscription.unsubscribe()),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        this.deps.logger.warn(
          { err: result.reason, root: repository.discovered.root, folder: state.folder },
          "Failed to release a nested repository observer",
        );
      }
    }
  }

  private async readRepository(
    state: FolderState,
    repository: RepositoryState,
  ): Promise<NestedChangesRepository | null> {
    try {
      return await this.statusLimit(() =>
        readRepositoryChanges(repository.discovered, {
          runGit: this.runGit,
          now: this.now,
          signal: state.abort.signal,
        }),
      );
    } catch (error) {
      // Only an aborted (closed) folder rejects; any other failure is in the result's error field.
      if (state.abort.signal.aborted) return null;
      throw error;
    }
  }

  private async refreshRepository(state: FolderState, repository: RepositoryState): Promise<void> {
    do {
      repository.rerun = false;
      repository.lastStartedAtMs = this.now();
      const next = await this.readRepository(state, repository);
      if (
        !next ||
        state.closed ||
        state.repositories.get(repository.discovered.root) !== repository
      )
        return;
      repository.latest = next;
      // Always emitted: a re-check with identical content still moves checkedAt, which the UI shows.
      this.emit(state, { repositories: [next], removed: [], truncated: state.truncated });
    } while (repository.rerun);
  }

  /** One status run per repository at a time; a trigger during a run requests exactly one more. */
  private scheduleRepository(
    state: FolderState,
    repository: RepositoryState,
    options: { force: boolean },
  ): Promise<void> {
    if (state.closed) return Promise.resolve();
    if (repository.running) {
      repository.rerun = true;
      return repository.running;
    }
    const wait = options.force
      ? 0
      : repository.lastStartedAtMs + NESTED_STATUS_MIN_GAP_MS - this.now();
    if (wait > 0) {
      repository.timer ??= setTimeout(() => {
        repository.timer = null;
        void this.scheduleRepository(state, repository, { force: true });
      }, wait);
      return Promise.resolve();
    }
    if (repository.timer) clearTimeout(repository.timer);
    repository.timer = null;
    const running = this.refreshRepository(state, repository)
      .catch((error: unknown) => {
        this.deps.logger.error(
          { err: error, root: repository.discovered.root },
          "Nested repository refresh failed unexpectedly",
        );
      })
      .finally(() => {
        repository.running = null;
      });
    repository.running = running;
    return running;
  }

  private startPass(state: FolderState, options: { discover: boolean; force: boolean }): void {
    void this.runPass(state, options).catch((error: unknown) => {
      if (state.closed) return;
      this.deps.logger.error({ err: error, folder: state.folder }, "Nested changes pass failed");
    });
  }

  /** Discovers (optionally) then refreshes every repository. Passes of one folder never overlap. */
  private async runPass(
    state: FolderState,
    options: { discover: boolean; force: boolean },
  ): Promise<void> {
    if (state.closed) return;
    if (state.pass) {
      state.passQueued = true;
      await state.pass;
      if (!state.passQueued) return;
    }
    state.passQueued = false;
    const pass = (async () => {
      if (options.discover) await this.discover(state);
      await Promise.all(
        [...state.repositories.values()].map((repository) =>
          this.scheduleRepository(state, repository, { force: options.force }),
        ),
      );
    })();
    state.pass = pass.finally(() => {
      if (state.pass === pass) state.pass = null;
    });
    await state.pass;
  }

  private armPoll(state: FolderState): void {
    if (state.pollTimer || state.closed) return;
    state.pollTimer = setTimeout(() => {
      state.pollTimer = null;
      if (state.closed) return;
      void this.runPass(state, { discover: true, force: false })
        .catch((error: unknown) => {
          if (!state.closed) {
            this.deps.logger.warn(
              { err: error, folder: state.folder },
              "Nested changes poll failed",
            );
          }
        })
        .finally(() => this.armPoll(state));
    }, NESTED_VISIBLE_POLL_MS);
  }

  private emit(state: FolderState, update: NestedChangesUpdate): void {
    for (const subscriber of state.subscribers) {
      if (subscriber.live) subscriber.onUpdate(update);
    }
  }

  // --- working-tree watching

  private async setWatchedRoots(
    state: FolderState,
    subscriber: Subscriber,
    roots: readonly string[],
  ): Promise<string[]> {
    const wanted = [...new Set(roots.map((root) => resolve(root)))]
      .filter((root) => state.repositories.has(root))
      .slice(-MAX_WATCHED_NESTED_CHECKOUTS);
    return this.applyWatchedRoots(state, subscriber, wanted);
  }

  private async applyWatchedRoots(
    state: FolderState,
    subscriber: Subscriber,
    wanted: readonly string[],
  ): Promise<string[]> {
    const next = new Set(wanted);
    const releases: Promise<void>[] = [];
    for (const root of subscriber.watched) {
      if (next.has(root)) continue;
      const repository = state.repositories.get(root);
      const watcher = repository?.workingTreeWatchers.get(subscriber);
      repository?.workingTreeWatchers.delete(subscriber);
      if (watcher) releases.push(this.release(state, root, watcher));
    }
    const watched: string[] = [];
    await Promise.all(
      wanted.map(async (root) => {
        const repository = state.repositories.get(root);
        if (!repository) return;
        if (!repository.workingTreeWatchers.has(subscriber)) {
          const watcher = this.deps
            .observeWorkingTree(root, () =>
              this.scheduleRepository(state, repository, { force: false }),
            )
            .catch((error: unknown) => {
              this.deps.logger.warn(
                { err: error, root },
                "Could not watch the working tree of a nested repository; polling still applies",
              );
              return null;
            });
          repository.workingTreeWatchers.set(subscriber, watcher);
        }
        if ((await repository.workingTreeWatchers.get(subscriber)) !== null) watched.push(root);
      }),
    );
    subscriber.watched = watched.filter((root) => next.has(root));
    await Promise.all(releases);
    return wanted.filter((root) => watched.includes(root));
  }

  private async release(
    state: FolderState,
    root: string,
    watcher: Promise<Unsubscribable | null>,
  ): Promise<void> {
    try {
      await (await watcher)?.unsubscribe();
    } catch (error) {
      this.deps.logger.warn(
        { err: error, root, folder: state.folder },
        "Failed to release a nested repository working-tree watch",
      );
    }
  }
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
