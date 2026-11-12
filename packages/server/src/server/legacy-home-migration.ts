// COMPAT(paseo-home): earlier builds kept the daemon home at ~/.paseo. This one-time
// migration moves it to ~/.pimi at supervisor startup and is the only place that still
// knows the old name. Delete it once no earlier-build home can exist.
import { execFile } from "node:child_process";
import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { isPidLockOwnerRunning, pidLockInfoSchema } from "./pid-lock.js";

const execFileAsync = promisify(execFile);

const LEGACY_HOME_DIRNAME = ".paseo";
const LEGACY_PID_FILE = "paseo.pid";
const REWRITABLE_EXTENSION = ".json";
// Registries and config live in the home root and a few shallow folders. Never descend into
// bulky or foreign trees.
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "models", "worktrees", "plugins"]);
const MAX_REWRITE_DEPTH = 4;
const MAX_REWRITE_BYTES = 8 * 1024 * 1024;

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

async function legacyDaemonRunning(legacyHome: string): Promise<boolean> {
  try {
    const raw: unknown = JSON.parse(await readFile(path.join(legacyHome, LEGACY_PID_FILE), "utf8"));
    const lock = pidLockInfoSchema.safeParse(raw);
    return lock.success && isPidLockOwnerRunning(lock.data);
  } catch {
    return false;
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
 * PIMI_HOME. Throws if the old daemon is still running, because renaming a home under a
 * live daemon corrupts its state.
 */
export async function migrateLegacyHome(
  env: NodeJS.ProcessEnv = process.env,
  log: (message: string) => void = () => {},
): Promise<LegacyHomeMigrationResult> {
  const userHome = os.homedir();
  const from = path.join(userHome, LEGACY_HOME_DIRNAME);
  const to = path.join(userHome, ".pimi");
  const none = { migrated: false, from, to, rewrittenFiles: 0, repairedWorktrees: 0 };
  if (env.PIMI_HOME) return none;
  if ((await exists(to)) || !(await exists(from))) return none;
  if (await legacyDaemonRunning(from)) {
    throw new Error(
      `The daemon home ${from} is still in use by a running daemon. Stop that daemon, then start Pimi again to move it to ${to}.`,
    );
  }
  await rename(from, to);
  await rm(path.join(to, LEGACY_PID_FILE), { force: true });
  const rewrittenFiles = await rewriteJsonFiles(to, from, to);
  const repairedWorktrees = await repairWorktrees(to, from);
  log(
    `Migrated daemon home ${from} -> ${to} (rewrote paths in ${rewrittenFiles} files, repaired ${repairedWorktrees} worktrees)`,
  );
  return { migrated: true, from, to, rewrittenFiles, repairedWorktrees };
}
