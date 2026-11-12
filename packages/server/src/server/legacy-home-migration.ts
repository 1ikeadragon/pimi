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
  constructor(home: string, to: string) {
    super(
      `The old daemon home ${home} is still in use by a running daemon. Quit the old Paseo app and run "paseo daemon stop" (or quit its "Paseo Supervisor" process), then start Pimi again to move it to ${to}.`,
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

// Absolute paths into the old home, agent label keys ("paseo.parent-agent-id" and friends),
// and the "<paseo-system>" message envelope tag all moved with the rename.
function rewriteLegacyText(text: string, from: string, to: string): string {
  return text
    .split(from)
    .join(to)
    .replace(/"paseo\.(?=[a-z])/g, '"pimi.')
    .replace(/(<\/?)paseo-system\b/g, "$1pimi-system");
}

async function rewriteJsonFiles(root: string, from: string, to: string): Promise<number> {
  let rewritten = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_REWRITE_DEPTH && !SKIPPED_DIRECTORIES.has(entry.name)) {
          await visit(entryPath, depth + 1);
        }
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(REWRITABLE_EXTENSION)) continue;
      if ((await stat(entryPath)).size > MAX_REWRITE_BYTES) continue;
      const text = await readFile(entryPath, "utf8");
      const next = rewriteLegacyText(text, from, to);
      if (next === text) continue;
      await writeFile(entryPath, next);
      rewritten += 1;
    }
  };
  await visit(root, 0);
  return rewritten;
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
  if (!(await exists(legacyDir))) return;
  await rename(legacyDir, path.join(gitDir, "pimi"));
  const metadataPath = path.join(gitDir, "pimi", "worktree.json");
  if (!(await exists(metadataPath))) return;
  const text = await readFile(metadataPath, "utf8");
  await writeFile(metadataPath, rewriteLegacyText(text, from, to));
}

async function repairWorktrees(home: string, from: string): Promise<number> {
  const worktreesRoot = path.join(home, "worktrees");
  if (!(await exists(worktreesRoot))) return 0;
  let repaired = 0;
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
        repaired += 1;
      } catch {
        // A worktree whose main checkout is gone stays as it was.
      }
    }
  }
  return repaired;
}

/**
 * Moves ~/.paseo to ~/.pimi when only the old one exists, fixes absolute paths stored in
 * the home's JSON files, and repairs worktree links. Does nothing for a custom
 * PIMI_HOME. Renaming a home under a live daemon corrupts its state, so a running old daemon
 * is stopped first when `stopRunningDaemon` is set (the desktop app, whose upgrade replaced the
 * build that launched it) and otherwise throws LegacyDaemonRunningError.
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
  if (!(await exists(from)) || !(await isUnusedHome(to))) return none;
  const running = await readLegacyDaemonLock(from);
  if (running) {
    if (!options.stopRunningDaemon) throw new LegacyDaemonRunningError(from, to);
    log(`Stopping the old daemon (PID ${running.pid}) that still runs from ${from}`);
    await stopLegacyDaemon(from, running);
  }
  await rm(to, { recursive: true, force: true });
  await rename(from, to);
  await rm(path.join(to, LEGACY_PID_FILE), { force: true });
  const rewrittenFiles = await rewriteJsonFiles(to, from, to);
  const repairedWorktrees = await repairWorktrees(to, from);
  log(
    `Migrated daemon home ${from} -> ${to} (rewrote paths in ${rewrittenFiles} files, repaired ${repairedWorktrees} worktrees)`,
  );
  return { migrated: true, from, to, rewrittenFiles, repairedWorktrees };
}
