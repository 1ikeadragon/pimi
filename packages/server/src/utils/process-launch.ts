import childProcess, { type ChildProcess } from "node:child_process";
import type { ExecFileOptions } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";

// One central seam between every program Pimi launches and the Network tab. The functions of
// node:child_process are wrapped once, so a launch by Pimi, a bundled dependency, or a provider
// SDK is seen without each call site opting in. A call site may still say why it launches
// something (withLaunchPurpose); everything else is classified by the program's name. The
// wrapper never changes arguments, environment, or results. Nothing here sees what the program
// does on the network. The Resources tab's sampler reads that from the OS, and uses the pid and
// agent attribution reported here to say whose process it is.

export interface ProcessLaunch {
  command: string;
  args: readonly string[];
  /** The environment the program starts with. Read for endpoint hints, never stored. */
  env: NodeJS.ProcessEnv | undefined;
  /** Display purpose set by the call site (a NETWORK_PURPOSE), or null to classify by name. */
  purpose: string | null;
  /** The agent whose work started this launch (withLaunchAgent), or null. */
  agentId: string | null;
}

export interface ProcessLaunchOutcome {
  exitCode?: number | null;
  signal?: string | null;
  /** Set when the program could not run at all, such as ENOENT. */
  errorCode?: string;
}

export interface ProcessLaunchTracker {
  exited(outcome: ProcessLaunchOutcome): void;
  /** The program started and has this pid. Not called for sync launches or failed starts. */
  spawned?(pid: number): void;
}

export type ProcessLaunchObserver = (launch: ProcessLaunch) => ProcessLaunchTracker;

const purposeStore = new AsyncLocalStorage<string>();
const agentStore = new AsyncLocalStorage<string>();

// The unwrapped function, taken before any observer installs wrappers. The resource sampler
// reads the process table through it, so its own `ps` and `lsof` never log themselves.
const unobservedExecFile = childProcess.execFile;
const unobservedSpawn = childProcess.spawn;

/** `spawn` that the launch observer never sees. Only for the sampler's own helper process. */
export function spawnUnobserved(
  ...args: Parameters<typeof childProcess.spawn>
): ReturnType<typeof childProcess.spawn> {
  return unobservedSpawn(...args);
}

export interface UnobservedExecResult {
  stdout: string;
  stderr: string;
}

/** Runs a program without telling the launch observer. Only for the sampler's own reads. */
export function execFileUnobserved(
  command: string,
  args: readonly string[],
  options: ExecFileOptions & { timeout: number; maxBuffer: number },
): Promise<UnobservedExecResult> {
  return new Promise((resolve, reject) => {
    unobservedExecFile(
      command,
      [...args],
      { ...options, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** Attributes every program launched inside `run` to the agent, for the Resources tab. */
export function withLaunchAgent<T>(agentId: string, run: () => T): T {
  return agentStore.run(agentId, run);
}

/** Attributes every launch started inside `run` to `purpose`. */
export function withLaunchPurpose<T>(purpose: string, run: () => T): T {
  return purposeStore.run(purpose, run);
}

let observer: ProcessLaunchObserver | null = null;
let installed = false;

/** Sets the observer that receives every launch. Pass null to stop observing. */
export function setProcessLaunchObserver(next: ProcessLaunchObserver | null): void {
  observer = next;
  if (next) installChildProcessWrappers();
}

function begin(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv | undefined,
): LaunchHandle | null {
  if (!observer) return null;
  try {
    const tracker = observer({
      command,
      args,
      env,
      purpose: purposeStore.getStore() ?? null,
      agentId: agentStore.getStore() ?? null,
    });
    let ended = false;
    return {
      end: (outcome) => {
        if (ended) return;
        ended = true;
        try {
          tracker.exited(outcome);
        } catch {
          // Observation must never affect the launched program.
        }
      },
      spawned: (pid) => {
        try {
          tracker.spawned?.(pid);
        } catch {
          // Observation must never affect the launched program.
        }
      },
    };
  } catch {
    return null;
  }
}

interface LaunchHandle {
  end(outcome: ProcessLaunchOutcome): void;
  spawned(pid: number): void;
}

function watchChild(child: ChildProcess, launch: LaunchHandle): void {
  if (typeof child.pid === "number") launch.spawned(child.pid);
  child.once("error", (error: NodeJS.ErrnoException) => {
    launch.end({ errorCode: typeof error.code === "string" ? error.code : "ERROR" });
  });
  child.once("close", (exitCode, signal) => launch.end({ exitCode, signal }));
}

interface LaunchOptions {
  env?: NodeJS.ProcessEnv;
  shell?: boolean | string;
  execPath?: string;
  args?: readonly string[];
}

function isOptions(value: unknown): value is LaunchOptions {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findOptions(values: readonly unknown[]): LaunchOptions | undefined {
  return values.find(isOptions);
}

// A launch with a shell runs a command line, so the first word is the program. Splitting it is
// only for display and classification.
function shellProgram(commandLine: string): { command: string; args: string[] } {
  const [command = commandLine, ...args] = commandLine.trim().split(/\s+/);
  return { command, args };
}

function describeSpawn(
  command: string,
  rest: readonly unknown[],
): {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv | undefined;
} {
  const args = Array.isArray(rest[0]) ? (rest[0] as string[]) : [];
  const options = findOptions(rest);
  if (options?.shell) {
    const parsed = shellProgram([command, ...args].join(" "));
    return { ...parsed, env: options.env };
  }
  return { command, args, env: options?.env };
}

function failureOutcome(error: unknown): ProcessLaunchOutcome {
  const failure = error as { status?: unknown; code?: unknown; signal?: unknown };
  const signal = typeof failure.signal === "string" ? failure.signal : null;
  if (typeof failure.status === "number") return { exitCode: failure.status, signal };
  return { errorCode: typeof failure.code === "string" ? failure.code : (signal ?? "ERROR") };
}

type AnyFunction = (...args: unknown[]) => unknown;

function copyStatics(wrapper: AnyFunction, original: AnyFunction): void {
  // Own properties of the original survive the wrapping, except promisify.custom, which is
  // rebuilt for exec and execFile because the original would bypass the wrapper.
  for (const key of Reflect.ownKeys(original)) {
    if (key === "length" || key === "name" || key === "prototype" || key === promisify.custom) {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(original, key);
    if (descriptor) Object.defineProperty(wrapper, key, descriptor);
  }
}

function wrapAsync(
  name: "spawn" | "execFile" | "exec" | "fork",
  describe: (args: unknown[]) => ReturnType<typeof describeSpawn>,
): void {
  const original = childProcess[name] as unknown as AnyFunction;
  const wrapper = function (this: unknown, ...args: unknown[]) {
    const launch = observer ? describe(args) : null;
    const handle = launch ? begin(launch.command, launch.args, launch.env) : null;
    const child = original.apply(this, args) as ChildProcess;
    if (handle && child && typeof child.once === "function") watchChild(child, handle);
    return child;
  };
  copyStatics(wrapper, original);
  if (name === "exec" || name === "execFile") {
    // The copied promisify.custom would call the original function, so rebuild it on the wrapper.
    Object.defineProperty(wrapper, promisify.custom, {
      configurable: true,
      value: (...args: unknown[]) => {
        let child: ChildProcess | undefined;
        const result = new Promise((resolve, reject) => {
          child = wrapper(...args, (error: Error | null, stdout: unknown, stderr: unknown) => {
            if (error) reject(Object.assign(error, { stdout, stderr }));
            else resolve({ stdout, stderr });
          }) as ChildProcess;
        });
        return Object.assign(result, { child });
      },
    });
  }
  (childProcess as unknown as Record<string, unknown>)[name] = wrapper;
}

function wrapSync(
  name: "spawnSync" | "execFileSync" | "execSync",
  describe: (args: unknown[]) => ReturnType<typeof describeSpawn>,
): void {
  const original = childProcess[name] as unknown as AnyFunction;
  const wrapper = function (this: unknown, ...args: unknown[]) {
    const launch = observer ? describe(args) : null;
    const end = launch ? (begin(launch.command, launch.args, launch.env)?.end ?? null) : null;
    if (!end) return original.apply(this, args);
    try {
      const result = original.apply(this, args);
      const spawnResult = result as {
        status?: number | null;
        signal?: string | null;
        error?: Error;
      };
      if (name === "spawnSync") {
        end(
          spawnResult.error
            ? failureOutcome(spawnResult.error)
            : { exitCode: spawnResult.status ?? null, signal: spawnResult.signal ?? null },
        );
      } else {
        end({ exitCode: 0 });
      }
      return result;
    } catch (error) {
      end(failureOutcome(error));
      throw error;
    }
  };
  copyStatics(wrapper, original);
  (childProcess as unknown as Record<string, unknown>)[name] = wrapper;
}

function installChildProcessWrappers(): void {
  if (installed) return;
  installed = true;
  const spawnLike = (args: unknown[]) => describeSpawn(String(args[0]), args.slice(1));
  wrapAsync("spawn", spawnLike);
  wrapAsync("execFile", spawnLike);
  wrapAsync("exec", (args) => {
    const parsed = shellProgram(String(args[0]));
    return { ...parsed, env: findOptions(args.slice(1))?.env };
  });
  wrapAsync("fork", (args) => {
    const rest = args.slice(1);
    const options = findOptions(rest);
    const forkArgs = Array.isArray(rest[0]) ? (rest[0] as string[]) : [];
    return {
      command: options?.execPath ?? process.execPath,
      args: [String(args[0]), ...forkArgs],
      env: options?.env,
    };
  });
  wrapSync("spawnSync", spawnLike);
  wrapSync("execFileSync", spawnLike);
  wrapSync("execSync", (args) => {
    const parsed = shellProgram(String(args[0]));
    return { ...parsed, env: findOptions(args.slice(1))?.env };
  });
  // Named imports of already loaded ES modules follow the new functions.
  syncBuiltinESMExports();
}
