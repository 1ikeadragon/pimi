import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { resolvePimiHome } from "@pimi/server/daemon-control";
import { validatePort, validateSshHost } from "@pimi/protocol/ssh-transport";

// One ssh connection per machine, shared by every ssh Pimi starts for it (ControlMaster). It cuts
// each connect from a full TCP + key exchange + sign-in to a round trip. Win32-OpenSSH has no
// multiplexing, so Windows keeps one ssh per use.
//
// The control socket lives in /tmp/pimi-<uid>-<hash of PIMI_HOME>/, mode 0700, never under
// PIMI_HOME or os.tmpdir(): a unix socket path must stay under 104 bytes, and ssh appends 17 more
// while it binds. `%C` is ssh's own hash of local host, remote host, port and user (40 hex).

const CONTROL_FILE = "m-%C";

/**
 * `-F <file>` for every ssh Pimi starts when PIMI_SSH_CONFIG is set. Without it ssh reads
 * ~/.ssh/config as usual; this is for a dedicated config, e.g. a throwaway test machine.
 */
export function sshConfigArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const file = env.PIMI_SSH_CONFIG?.trim();
  return file ? ["-F", file] : [];
}

let cachedDir: string | null | undefined;

function controlDir(): string | null {
  if (process.platform === "win32") return null;
  if (cachedDir !== undefined) return cachedDir;
  cachedDir = prepareControlDir();
  return cachedDir;
}

function prepareControlDir(): string | null {
  const uid = process.getuid?.() ?? 0;
  const homeKey = createHash("sha256")
    .update(resolvePimiHome(process.env))
    .digest("hex")
    .slice(0, 8);
  const dir = path.join("/tmp", `pimi-${uid}-${homeKey}`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // A directory someone else pre-created under this predictable name must not hold our sockets.
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.uid !== uid) return null;
    chmodSync(dir, 0o700);
    return dir;
  } catch {
    return null;
  }
}

/** The ControlPath ssh option value, or null when this desktop cannot multiplex (Windows, no safe dir). */
export function controlPathOption(): string | null {
  const dir = controlDir();
  return dir ? path.join(dir, CONTROL_FILE) : null;
}

function exitArgs(controlPath: string, host: string, sshPort: number | undefined): string[] {
  return [
    ...sshConfigArgs(),
    "-O",
    "exit",
    "-o",
    `ControlPath=${controlPath}`,
    ...(sshPort !== undefined ? ["-p", String(validatePort(sshPort, "SSH port"))] : []),
    validateSshHost(host),
  ];
}

/**
 * Stops the shared connection for one machine. Its tunnels end with it. Used when the machine's
 * sign-in is forgotten, so the next connect signs in again instead of reusing the old session.
 */
export function exitControlMaster(target: { host: string; sshPort?: number }): void {
  const controlPath = controlPathOption();
  if (!controlPath) return;
  const child = spawn("ssh", exitArgs(controlPath, target.host, target.sshPort), {
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => undefined);
  setTimeout(() => child.kill(), 5_000).unref();
}

/**
 * Quit hook: stops every shared connection this app started and removes the control sockets.
 * Synchronous on purpose, the process is about to exit. A master that ignores `-O exit` dies with
 * its listener gone after ControlPersist, and the directory is removed regardless.
 */
export function closeAllControlMasters(): void {
  const dir = cachedDir;
  if (!dir) return;
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    return;
  }
  // The agent endpoint sockets can share this directory, so only the control sockets go.
  for (const file of files.filter((name) => name.startsWith("m-"))) {
    const socket = path.join(dir, file);
    spawnSync(
      "ssh",
      [...sshConfigArgs(), "-O", "exit", "-o", `ControlPath=${socket}`, "pimi-control-exit"],
      { stdio: "ignore", timeout: 3_000, windowsHide: true },
    );
    rmSync(socket, { force: true });
  }
  try {
    rmdirSync(dir);
  } catch {
    // Still holds agent endpoint sockets, which their own quit hook removes.
  }
  cachedDir = undefined;
}
