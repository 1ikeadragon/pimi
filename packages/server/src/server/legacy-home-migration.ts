// COMPAT(paseo-home): earlier builds kept the daemon home at ~/.paseo. This one-time
// migration moves it to ~/.pimi at supervisor startup and is the only place that still
// knows the old name. Delete it once no earlier-build home can exist.
import { execFile } from "node:child_process";
import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import treeKill from "tree-kill";
import os from "node:os";
import path from "node:path";
import { isPidLockOwnerRunning, pidLockInfoSchema, type PidLockInfo } from "./pid-lock.js";

const execFileAsync = promisify(execFile);

const LEGACY_HOME_DIRNAME = ".paseo";
const LEGACY_PID_FILE = "paseo.pid";
const LEGACY_SUPERVISOR_TITLE = "Paseo Supervisor";
// Written into the old home before it is renamed, so it exists in the new home from the moment
// the rename lands. It stays until the rewrite and repair finished, and the next start finishes
// what a crash left undone (both steps are idempotent).
const PENDING_MARKER = ".legacy-migration-pending";
const MAX_FINISH_ATTEMPTS = 3;
// Object keys persisted in the home's JSON (workspace registry, user config, terminal worker
// records) that the rename changed. Only exact keys are mapped; values are never touched.
const RENAMED_KEYS = {
  isPaseoOwnedWorktree: "isPimiOwnedWorktree",
  paseoTools: "pimiTools",
  paseoVersion: "pimiVersion",
} as const;
const REWRITABLE_EXTENSION = ".json";
// Registries and config live in the home root and a few shallow folders. Never descend into
// bulky or foreign trees.
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "models", "worktrees", "plugins"]);
const MAX_REWRITE_DEPTH = 4;
const MAX_REWRITE_BYTES = 8 * 1024 * 1024;
const LEGACY_STOP_TIMEOUT_MS = 15_000;
const LEGACY_WORKER_GRACE_MS = 3_000;
const POLL_INTERVAL_MS = 100;

/** The old daemon still owns ~/.paseo, so the home cannot move yet. */
export class LegacyDaemonRunningError extends Error {
  constructor(home: string, to: string, pid: number) {
    super(
      `The old daemon home ${home} is still in use by a running daemon. Open the Pimi desktop app (it stops the old daemon), or kill PID ${pid} (process "Paseo Supervisor"), then run this command again to move it to ${to}.`,
    );
    this.name = "LegacyDaemonRunningError";
  }
}

export interface LegacyHomeMigrationResult {
  migrated: boolean;
  from: string;
  to: string;
  rewrittenFiles: number;
  repairedWorktrees: number;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

// A CLI command aimed at another daemon (--host) writes its client id here before any daemon
// has used the home. That file alone does not make the home worth keeping over the old one.
async function isUnusedHome(home: string): Promise<boolean> {
  try {
    const entries = await readdir(home);
    return entries.every((name) => name === "cli-client-id");
  } catch {
    return true;
  }
}

async function readLegacyDaemonLock(legacyHome: string): Promise<PidLockInfo | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(path.join(legacyHome, LEGACY_PID_FILE), "utf8"));
    const lock = pidLockInfoSchema.safeParse(raw);
    return lock.success && isPidLockOwnerRunning(lock.data) ? lock.data : null;
  } catch {
    return null;
  }
}

function killTree(pid: number, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
  return new Promise((resolve) => treeKill(pid, signal, () => resolve()));
}

async function waitUntil(done: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() >= deadline) return false;
    await delay(POLL_INTERVAL_MS);
  }
  return true;
}

// Earlier builds ran each terminal worker as a detached process marked with `--paseo-home`.
// Their record format is not the current one, so the process table is the only index.
async function listLegacyWorkerPids(legacyHome: string): Promise<number[]> {
  if (process.platform === "win32") return []; // Terminals end with the supervisor's process tree.
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="], {
    maxBuffer: 32 * 1024 * 1024,
  });
  const marker = `--paseo-home ${legacyHome}`;
  const pids: number[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match?.[2]?.includes("--paseo-terminal-worker")) continue;
    const command = match[2];
    const at = command.indexOf(marker);
    if (at === -1 || (command[at + marker.length] ?? " ") !== " ") continue;
    pids.push(Number(match[1]));
  }
  return pids;
}

async function readProcessCommand(pid: number): Promise<string | null> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
        ],
        { timeout: 15_000 },
      );
      return stdout.trim() || null;
    }
    const { stdout } = await execFileAsync("ps", ["-o", "command=", "-p", String(pid)]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// A lock file outlives its daemon, and the OS reuses PIDs. Only a process that still presents
// itself as the old supervisor (its title, or its entry script on Windows where titles are
// not part of the command line) is the daemon the lock names.
async function isLegacySupervisor(pid: number): Promise<boolean> {
  const command = await readProcessCommand(pid);
  if (!command) return false;
  return command.includes(LEGACY_SUPERVISOR_TITLE) || command.includes("supervisor-entrypoint");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Stops the old daemon the way a quit does: SIGTERM asks the supervisor to close its terminals
 * and exit (taskkill on Windows), SIGKILL follows only if it does not. Terminal workers it
 * leaves behind are closed too. Returns once the supervisor has exited.
 */
async function stopLegacyDaemon(legacyHome: string, lock: PidLockInfo): Promise<void> {
  if (lock.pid <= 1 || lock.pid === process.pid) {
    throw new Error(`Refusing to stop invalid daemon PID ${lock.pid} for ${legacyHome}`);
  }
  if (!(await isLegacySupervisor(lock.pid))) {
    throw new Error(
      `PID ${lock.pid} in ${legacyHome} is not a "${LEGACY_SUPERVISOR_TITLE}" process, so it was not stopped. Stop the old daemon yourself, then start Pimi again.`,
    );
  }
  await killTree(lock.pid, "SIGTERM");
  let exited = await waitUntil(() => !isPidLockOwnerRunning(lock), LEGACY_STOP_TIMEOUT_MS);
  if (!exited) {
    await killTree(lock.pid, "SIGKILL");
    exited = await waitUntil(() => !isPidLockOwnerRunning(lock), LEGACY_WORKER_GRACE_MS);
  }
  if (!exited) {
    throw new Error(`The old daemon (PID ${lock.pid}) for ${legacyHome} did not exit.`);
  }
  const workers = await listLegacyWorkerPids(legacyHome);
  if (workers.length === 0) return;
  await Promise.all(workers.map((pid) => killTree(pid, "SIGTERM")));
  const closed = await waitUntil(() => !workers.some(isAlive), LEGACY_WORKER_GRACE_MS);
  if (!closed) {
    await Promise.all(workers.filter(isAlive).map((pid) => killTree(pid, "SIGKILL")));
  }
}

// Absolute paths into the old home (plain and JSON-escaped, which differs on Windows), agent
// label keys ("paseo.parent-agent-id" and friends), the "<paseo-system>" message envelope tag,
// attachment mime types, and the persisted object keys that carried the old name all moved
// with the rename.
function rewriteLegacyText(text: string, from: string, to: string): string {
  const jsonEscape = (value: string): string => JSON.stringify(value).slice(1, -1);
  let next = text.split(from).join(to);
  if (jsonEscape(from) !== from) next = next.split(jsonEscape(from)).join(jsonEscape(to));
  return next
    .replace(/"paseo\.(?=[a-z])/g, '"pimi.')
    .replace(/(<\/?)paseo-system\b/g, "$1pimi-system")
    .replace(/"application\/paseo-(?=[a-z])/g, '"application/pimi-')
    .replace(
      /"(isPaseoOwnedWorktree|paseoTools|paseoVersion)"(?=\s*:)/g,
      (_match, key: keyof typeof RENAMED_KEYS) => `"${RENAMED_KEYS[key]}"`,
    );
}

interface RewriteResult {
  rewritten: number;
  failed: number;
}

async function rewriteJsonFiles(
  root: string,
  from: string,
  to: string,
  log: (message: string) => void,
): Promise<RewriteResult> {
  const result: RewriteResult = { rewritten: 0, failed: 0 };
  const visit = async (directory: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      result.failed += 1;
      log(`Skipped unreadable directory ${directory}: ${describe(error)}`);
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_REWRITE_DEPTH && !SKIPPED_DIRECTORIES.has(entry.name)) {
          await visit(entryPath, depth + 1);
        }
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(REWRITABLE_EXTENSION)) continue;
      try {
        if ((await stat(entryPath)).size > MAX_REWRITE_BYTES) continue;
        const text = await readFile(entryPath, "utf8");
        const next = rewriteLegacyText(text, from, to);
        if (next === text) continue;
        await writeFile(entryPath, next);
        result.rewritten += 1;
      } catch (error) {
        result.failed += 1;
        log(`Skipped ${entryPath}: ${describe(error)}`);
      }
    }
  };
  await visit(root, 0);
  return result;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Moving a linked worktree breaks the two-way link git keeps with its main checkout. Pimi's
// ownership record for it sits in the git dir under the old name.
async function moveWorktreeMetadata(worktreePath: string, from: string, to: string): Promise<void> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--absolute-git-dir"], {
    cwd: worktreePath,
    timeout: 30_000,
  });
  const gitDir = stdout.trim();
  const legacyDir = path.join(gitDir, "paseo");
  const currentDir = path.join(gitDir, "pimi");
  if ((await exists(legacyDir)) && !(await exists(currentDir))) {
    await rename(legacyDir, currentDir);
  }
  // Rewritten even when the directory was already moved: a crash between the two steps must
  // not leave the old paths behind.
  const metadataPath = path.join(currentDir, "worktree.json");
  if (!(await exists(metadataPath))) return;
  const text = await readFile(metadataPath, "utf8");
  const next = rewriteLegacyText(text, from, to);
  if (next !== text) await writeFile(metadataPath, next);
}

async function repairWorktrees(
  home: string,
  from: string,
  log: (message: string) => void,
): Promise<{ repaired: number; failed: number }> {
  const worktreesRoot = path.join(home, "worktrees");
  const result = { repaired: 0, failed: 0 };
  if (!(await exists(worktreesRoot))) return result;
  try {
    for (const project of await readdir(worktreesRoot, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const projectRoot = path.join(worktreesRoot, project.name);
      for (const worktree of await readdir(projectRoot, { withFileTypes: true })) {
        const worktreePath = path.join(projectRoot, worktree.name);
        if (!worktree.isDirectory() || !(await exists(path.join(worktreePath, ".git")))) continue;
        try {
          await execFileAsync("git", ["worktree", "repair", worktreePath], {
            cwd: worktreePath,
            timeout: 30_000,
          });
          await moveWorktreeMetadata(worktreePath, from, home);
          result.repaired += 1;
        } catch (error) {
          // A worktree whose main checkout is gone stays as it was; the next start retries.
          result.failed += 1;
          log(`Could not repair worktree ${worktreePath}: ${describe(error)}`);
        }
      }
    }
  } catch (error) {
    result.failed += 1;
    log(`Could not scan worktrees under ${worktreesRoot}: ${describe(error)}`);
  }
  return result;
}

interface PendingMarker {
  from: string;
  attempts: number;
}

async function readPendingMarker(home: string): Promise<PendingMarker | null> {
  let raw: string;
  try {
    raw = await readFile(path.join(home, PENDING_MARKER), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PendingMarker>;
    if (typeof parsed.from === "string") {
      return { from: parsed.from, attempts: Number(parsed.attempts) || 0 };
    }
  } catch {
    // An unreadable marker still means a move happened and was not finished.
  }
  return { from: "", attempts: 0 };
}

/**
 * Rewrites and repairs a home that was just renamed (or whose rename was interrupted before
 * this ran to the end). Idempotent: the marker goes only once every file was rewritten, or
 * after MAX_FINISH_ATTEMPTS starts that each skipped a file, so a file that can never be read
 * does not rescan the home forever.
 */
async function finishMigration(
  to: string,
  from: string,
  attempts: number,
  log: (message: string) => void,
): Promise<{ rewrittenFiles: number; repairedWorktrees: number }> {
  await rm(path.join(to, LEGACY_PID_FILE), { force: true });
  const rewrite = await rewriteJsonFiles(to, from, to, log);
  const repair = await repairWorktrees(to, from, log);
  const failed = rewrite.failed + repair.failed;
  if (failed === 0 || attempts + 1 >= MAX_FINISH_ATTEMPTS) {
    await rm(path.join(to, PENDING_MARKER), { force: true });
  } else {
    await writeFile(
      path.join(to, PENDING_MARKER),
      JSON.stringify({ from, attempts: attempts + 1 } satisfies PendingMarker),
    );
  }
  return { rewrittenFiles: rewrite.rewritten, repairedWorktrees: repair.repaired };
}

/**
 * Moves ~/.paseo to ~/.pimi when only the old one exists, fixes absolute paths stored in
 * the home's JSON files, and repairs worktree links. Does nothing for a custom
 * PIMI_HOME. Renaming a home under a live daemon corrupts its state, so a running old daemon
 * is stopped first when `stopRunningDaemon` is set (the desktop app, whose upgrade replaced the
 * build that launched it) and otherwise throws LegacyDaemonRunningError. A pending marker
 * travels with the renamed home: while it exists, the next call finishes the rewrite and repair
 * that an interrupted run left undone.
 */
export async function migrateLegacyHome(
  env: NodeJS.ProcessEnv = process.env,
  log: (message: string) => void = () => {},
  options: { stopRunningDaemon?: boolean } = {},
): Promise<LegacyHomeMigrationResult> {
  const userHome = os.homedir();
  const from = path.join(userHome, LEGACY_HOME_DIRNAME);
  const to = path.join(userHome, ".pimi");
  const none = { migrated: false, from, to, rewrittenFiles: 0, repairedWorktrees: 0 };
  if (env.PIMI_HOME) return none;
  const pending = await readPendingMarker(to);
  if (pending) {
    log(`Finishing the interrupted move of ${pending.from || from} to ${to}`);
    const done = await finishMigration(to, pending.from || from, pending.attempts, log);
    return { migrated: true, from, to, ...done };
  }
  if (!(await exists(from)) || !(await isUnusedHome(to))) return none;
  const running = await readLegacyDaemonLock(from);
  if (running) {
    if (!options.stopRunningDaemon) throw new LegacyDaemonRunningError(from, to, running.pid);
    log(`Stopping the old daemon (PID ${running.pid}) that still runs from ${from}`);
    await stopLegacyDaemon(from, running);
  }
  // The marker is written inside the old home so the rename carries it: there is no moment
  // where the new home exists without it.
  await writeFile(
    path.join(from, PENDING_MARKER),
    JSON.stringify({ from, attempts: 0 } satisfies PendingMarker),
  );
  await rm(to, { recursive: true, force: true });
  await rename(from, to);
  const done = await finishMigration(to, from, 0, log);
  log(
    `Migrated daemon home ${from} -> ${to} (rewrote paths in ${done.rewrittenFiles} files, repaired ${done.repairedWorktrees} worktrees)`,
  );
  return { migrated: true, from, to, ...done };
}
