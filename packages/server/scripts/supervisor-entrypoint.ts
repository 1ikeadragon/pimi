import { fileURLToPath } from "url";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  acquirePidLock,
  PidLockError,
  releasePidLock,
  startPidLockHeartbeat,
  updatePidLock,
} from "../src/server/pid-lock.js";
import { resolvePimiHome } from "../src/server/pimi-home.js";
import { daemonLogPath } from "../src/server/daemon-instance.js";
import { PRIVATE_FILE_MODE } from "../src/server/private-files.js";
import { loadPersistedConfig } from "../src/server/persisted-config.js";
import { reapTerminalWorkers } from "../src/terminal/terminal-worker-reaper.js";
import { runSupervisor } from "./supervisor.js";
import { resolveSupervisorLogFile } from "./supervisor-log-config.js";

process.title = "Pimi Supervisor";

interface DaemonRunnerConfig {
  devMode: boolean;
  workerArgs: string[];
}

function parseConfig(argv: string[]): DaemonRunnerConfig {
  let devMode = false;
  const workerArgs: string[] = [];

  for (const arg of argv) {
    if (arg === "--dev") {
      devMode = true;
      continue;
    }
    if (arg === "--reclaim-stale-pid-lock") {
      throw new Error(
        "--reclaim-stale-pid-lock was removed: stop the existing supervisor before starting another.",
      );
    }
    workerArgs.push(arg);
  }

  return { devMode, workerArgs };
}

function resolveWorkerEntry(): string {
  const candidates = [
    fileURLToPath(new URL("../server/server/daemon-worker.js", import.meta.url)),
    fileURLToPath(new URL("../dist/server/server/daemon-worker.js", import.meta.url)),
    fileURLToPath(new URL("../src/server/daemon-worker.ts", import.meta.url)),
    fileURLToPath(new URL("../../src/server/daemon-worker.ts", import.meta.url)),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}

function resolveDevWorkerEntry(): string {
  const candidate = fileURLToPath(new URL("../src/server/daemon-worker.ts", import.meta.url));
  if (!existsSync(candidate)) {
    throw new Error(`Dev worker entry not found: ${candidate}`);
  }
  return candidate;
}

/**
 * Old-space limit of the worker, in MiB. One synthetic 350 MiB Claude chat peaked at 1.1 GB RSS in
 * a full replay and a rewind of a big chat holds up to REWIND_MAX_RETAINED_BYTES (256 MiB) of
 * parsed entries several times over; Node's default (about 2 GB on a 64-bit machine with enough
 * RAM, less on a small one) ends the daemon that owns every chat. The development launch already
 * used this value.
 */
const WORKER_MAX_OLD_SPACE_MB = 3072;

/** V8 flags every worker gets: a larger heap, and a diagnostic report when it still runs out. */
function workerHeapArgs(pimiHome: string): string[] {
  return [
    `--max-old-space-size=${WORKER_MAX_OLD_SPACE_MB}`,
    "--report-on-fatalerror",
    `--report-directory=${path.join(pimiHome, "crash-reports")}`,
  ];
}

function resolveWorkerExecArgv(
  workerEntry: string,
  devMode: boolean,
  heapArgs: readonly string[],
): string[] {
  const execArgv = workerEntry.endsWith(".ts") ? ["--import", "tsx"] : [];
  if (!devMode) {
    return [...heapArgs, ...execArgv];
  }
  const devArgs = ["--heapsnapshot-near-heap-limit=3", ...heapArgs];
  const inspectArg = process.env.PIMI_NODE_INSPECT ?? "--inspect";
  if (inspectArg !== "0" && inspectArg !== "false" && inspectArg !== "off") {
    devArgs.push(inspectArg);
  }
  return [...devArgs, ...execArgv];
}

function resolvePackagedNodeEntrypointRunnerPath(currentScriptPath: string): string | null {
  const packageMarker = `${path.sep}node_modules${path.sep}@pimi${path.sep}server${path.sep}`;
  const markerIndex = currentScriptPath.lastIndexOf(packageMarker);
  if (markerIndex === -1) {
    return null;
  }

  const appRoot = currentScriptPath.slice(0, markerIndex);
  const runnerPath = path.join(appRoot, "dist", "daemon", "node-entrypoint-runner.js");
  return existsSync(runnerPath) ? runnerPath : null;
}

async function main(): Promise<void> {
  const config = parseConfig(process.argv.slice(2));
  const workerEntry = config.devMode ? resolveDevWorkerEntry() : resolveWorkerEntry();
  const workerEnv: NodeJS.ProcessEnv = { ...process.env };
  const pimiHome = resolvePimiHome(workerEnv);
  const heapArgs = workerHeapArgs(pimiHome);
  const workerExecArgv = resolveWorkerExecArgv(workerEntry, config.devMode, heapArgs);
  const packagedNodeEntrypointRunner =
    process.env.ELECTRON_RUN_AS_NODE === "1"
      ? resolvePackagedNodeEntrypointRunnerPath(fileURLToPath(import.meta.url))
      : null;

  const persistedConfig = loadPersistedConfig(pimiHome);
  const supervisorLogFile = resolveSupervisorLogFile(pimiHome, persistedConfig, workerEnv);

  try {
    await acquirePidLock(pimiHome, null, {
      ownerPid: process.pid,
    });
  } catch (error) {
    if (error instanceof PidLockError) {
      failStartup(error.message, error.message);
    }
    throw error;
  }

  let lockReleased = false;
  let requestSupervisorShutdown: ((reason: string) => void) | null = null;
  const stopLockHeartbeat = startPidLockHeartbeat(pimiHome, {
    ownerPid: process.pid,
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`PID lock heartbeat failed: ${message}\n`);
      if (error instanceof PidLockError) {
        requestSupervisorShutdown?.("pid_lock_ownership_lost");
      }
    },
  });
  const releaseLock = async (): Promise<void> => {
    if (lockReleased) {
      return;
    }
    lockReleased = true;
    stopLockHeartbeat();
    await releasePidLock(pimiHome, {
      ownerPid: process.pid,
    });
  };

  const supervisor = runSupervisor({
    name: "DaemonRunner",
    startupMessage: "Starting daemon worker (IPC restart and crash restart enabled)",
    resolveWorkerEntry: () => workerEntry,
    workerArgs: config.workerArgs,
    workerEnv,
    workerExecArgv,
    resolveWorkerSpawnSpec: packagedNodeEntrypointRunner
      ? (resolvedWorkerEntry) => ({
          command: process.execPath,
          // The packaged launch does not go through fork(), so execArgv never reaches it.
          args: [
            ...heapArgs,
            packagedNodeEntrypointRunner,
            "node-script",
            resolvedWorkerEntry,
            ...config.workerArgs,
          ],
          env: {
            ...workerEnv,
            ELECTRON_RUN_AS_NODE: "1",
          },
        })
      : undefined,
    restartOnCrash: true,
    logFile: supervisorLogFile,
    onWorkerReady: async ({ listen, serverId }) => {
      await updatePidLock(pimiHome, { listen, serverId }, { ownerPid: process.pid });
    },
    onWorkerExit: () =>
      updatePidLock(pimiHome, { listen: null, serverId: null }, { ownerPid: process.pid }),
    onSupervisorExit: releaseLock,
    cleanupTerminals: async (log) => {
      const result = await reapTerminalWorkers({ pimiHome, log });
      log("Terminal worker cleanup result", { ...result });
    },
  });
  requestSupervisorShutdown = supervisor.requestShutdown;
}

// The supervisor opens its log only after config and the PID lock succeed. A background
// launch discards stderr, so earlier failures also go to the log the launcher points at.
function failStartup(detail: string, summary: string): never {
  process.stderr.write(`${detail}\n`);
  try {
    const logPath = daemonLogPath(resolvePimiHome(process.env));
    mkdirSync(path.dirname(logPath), { recursive: true });
    appendFileSync(
      logPath,
      `${JSON.stringify({
        level: "fatal",
        time: new Date().toISOString(),
        pid: process.pid,
        name: "DaemonRunner",
        msg: summary,
      })}\n`,
      { mode: PRIVATE_FILE_MODE },
    );
  } catch {
    // stderr already carries the failure.
  }
  process.exit(1);
}

void main().catch((error) => {
  if (error instanceof Error) failStartup(error.stack ?? error.message, error.message);
  failStartup(String(error), String(error));
});
