import { execFile, type ExecFileException } from "node:child_process";
import { access, constants, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { VaultError } from "./errors.js";
import type { RedactingStream } from "./redactor.js";

// Runs one program with secrets in its environment and hands back redacted output. No shell: the
// program and its arguments reach execve as separate strings, so nothing in an argument is
// interpreted as syntax.

// Cap per stream (stdout, stderr). Tool output goes into a model's context; 256 KiB is already
// far more than a model reads usefully (roughly 60k tokens), and bounds the daemon's memory per
// run at about 512 KiB. Exceeding it kills the program and sets the `truncated` flag.
export const RUN_OUTPUT_CAP_BYTES = 256 * 1024;

// Default and ceiling for a run. The default stays inside the roughly 60 s a provider SDK allows
// one tool call (AGENT_WAIT_TIMEOUT_MS is 30 s of that, spent on approval when there is no grant),
// and a CLI call still silent after 30 s is usually waiting on input it will never get (stdin is
// closed) or on the network. Ten minutes is the longest a build or deploy step plausibly takes
// before an agent should run it as a background script instead; a caller may ask for up to it.
export const RUN_DEFAULT_TIMEOUT_MS = 30 * 1000;
export const RUN_MAX_TIMEOUT_MS = 10 * 60 * 1000;

// After the program is killed, how long to wait for its output pipes to close before giving up on
// them. A grandchild that inherited stdout keeps the pipe open after its parent dies, and
// `execFile` does not forward `detached`, so the program cannot be started in its own process
// group and killed as a tree. The pipes are cut instead. Two seconds is long enough for a killed
// program's last writes to arrive.
const PIPE_CLOSE_GRACE_MS = 2000;

export interface RunOptions {
  /** Symlink-resolved absolute path. */
  executable: string;
  args: readonly string[];
  cwd: string;
  /** The complete environment of the child. */
  env: Record<string, string>;
  timeoutMs: number;
  /** Creates one redacting stream per output stream. */
  redact: () => RedactingStream;
  signal?: AbortSignal;
}

export interface RunResult {
  exitCode: number | null;
  signal: string | null;
  /** Redacted. */
  stdout: string;
  stderr: string;
  truncated: { stdout: boolean; stderr: boolean };
  timedOut: boolean;
  durationMs: number;
}

function exitCodeOf(error: ExecFileException | null): number | null {
  if (error === null) return 0;
  return typeof error.code === "number" ? error.code : null;
}

function redactOutput(bytes: Buffer, stream: RedactingStream, truncated: boolean): string {
  const text = stream.push(bytes.toString("utf8"));
  if (truncated) {
    // The cut may sit inside a value; what the stream holds back could be its start.
    stream.discard();
    return text;
  }
  return text + stream.finish();
}

interface Captured {
  chunks: Buffer[];
  size: number;
  truncated: boolean;
}

type StreamName = "stdout" | "stderr";

export function runProgram(options: RunOptions): Promise<RunResult> {
  const startedAt = performance.now();
  return new Promise<RunResult>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const captured: Record<StreamName, Captured> = {
      stdout: { chunks: [], size: 0, truncated: false },
      stderr: { chunks: [], size: 0, truncated: false },
    };
    const timers: NodeJS.Timeout[] = [];

    const finish = (): boolean => {
      if (settled) return false;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
      return true;
    };

    const settle = (exit: { exitCode: number | null; signal: string | null }): void => {
      if (!finish()) return;
      const render = (name: StreamName): string =>
        redactOutput(
          Buffer.concat(captured[name].chunks),
          options.redact(),
          captured[name].truncated,
        );
      resolve({
        ...exit,
        stdout: render("stdout"),
        stderr: render("stderr"),
        truncated: { stdout: captured.stdout.truncated, stderr: captured.stderr.truncated },
        timedOut,
        durationMs: Math.round(performance.now() - startedAt),
      });
    };

    const child = execFile(
      options.executable,
      [...options.args],
      {
        cwd: options.cwd,
        env: options.env,
        encoding: "buffer",
        // Our own cap below fires first; this stops Node buffering a runaway stream regardless.
        maxBuffer: RUN_OUTPUT_CAP_BYTES * 2,
        windowsHide: true,
      },
      (error) => {
        if (error && error.code === "ENOENT") {
          if (finish()) {
            reject(
              new VaultError("invalid_argument", "The executable could not be started.", {
                cause: error,
              }),
            );
          }
          return;
        }
        settle({ exitCode: exitCodeOf(error), signal: error?.signal ?? null });
      },
    );

    const collect = (name: StreamName, chunk: Buffer): void => {
      const target = captured[name];
      if (target.truncated) return;
      const room = RUN_OUTPUT_CAP_BYTES - target.size;
      if (chunk.length > room) {
        target.chunks.push(chunk.subarray(0, room));
        target.size = RUN_OUTPUT_CAP_BYTES;
        target.truncated = true;
        stop();
        return;
      }
      target.chunks.push(chunk);
      target.size += chunk.length;
    };
    child.stdout?.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => collect("stderr", chunk));

    function stop(): void {
      child.kill("SIGKILL");
      timers.push(
        setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          settle({ exitCode: null, signal: "SIGKILL" });
        }, PIPE_CLOSE_GRACE_MS),
      );
    }
    timers.push(
      setTimeout(() => {
        timedOut = true;
        stop();
      }, options.timeoutMs),
    );
    options.signal?.addEventListener("abort", stop, { once: true });
    child.stdin?.end();
  });
}

// ---

// A PATH entry that is missing, is not a directory or is not searchable is normal.
const PROBE_MISS_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR", "EACCES"]);

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return false;
    await access(candidate, constants.X_OK);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && PROBE_MISS_CODES.has(String(error.code))) {
      return false;
    }
    throw error;
  }
}

/**
 * The absolute, symlink-resolved path `argv0` would start. A name with no separator is searched
 * on `searchPath`; a path is taken relative to `cwd`. Grants match on this path, so a symlink
 * swapped to another target changes the identity of what runs.
 */
export async function resolveExecutable(
  argv0: string,
  options: { cwd: string; searchPath: string },
): Promise<string> {
  const candidates: string[] = [];
  if (argv0.includes("/") || argv0.includes(path.sep)) {
    candidates.push(path.resolve(options.cwd, argv0));
  } else {
    const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
    for (const directory of options.searchPath.split(path.delimiter)) {
      if (!directory) continue;
      for (const extension of extensions) {
        candidates.push(path.join(directory, argv0 + extension));
      }
    }
  }
  for (const candidate of candidates) {
    if (await isExecutableFile(candidate)) return realpath(candidate);
  }
  throw new VaultError("invalid_argument", `Executable not found: ${argv0}`);
}
