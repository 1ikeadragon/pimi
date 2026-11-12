import type { ChildProcess } from "node:child_process";

// A narrow seam between code that launches programs and the Network tab. The daemon installs
// one observer at startup; callers that pass a purpose get a record of the launch (program,
// redacted arguments, exit code, duration). Nothing here sees what the program does on the
// network. With no observer installed, every function is a no-op.

export interface ProcessLaunch {
  command: string;
  args: readonly string[];
  /** Display purpose, one of NETWORK_PURPOSE. */
  purpose: string;
}

export interface ProcessLaunchOutcome {
  exitCode?: number | null;
  signal?: string | null;
  /** Set when the program could not run at all, such as ENOENT. */
  errorCode?: string;
}

export type ProcessLaunchObserver = (
  launch: ProcessLaunch,
) => (outcome: ProcessLaunchOutcome) => void;

let observer: ProcessLaunchObserver | null = null;

export function setProcessLaunchObserver(next: ProcessLaunchObserver | null): void {
  observer = next;
}

/** Returns a function that records how the launch ended, or null when nothing observes. */
export function beginProcessLaunch(
  launch: ProcessLaunch,
): ((outcome: ProcessLaunchOutcome) => void) | null {
  if (!observer) return null;
  try {
    const end = observer(launch);
    let ended = false;
    return (outcome) => {
      if (ended) return;
      ended = true;
      try {
        end(outcome);
      } catch {
        // Observation must never affect the launched program.
      }
    };
  } catch {
    return null;
  }
}

/** Records the launch of an already spawned child and its exit. */
export function trackChildProcess(child: ChildProcess, launch: ProcessLaunch): void {
  const end = beginProcessLaunch(launch);
  if (!end) return;
  child.once("error", (error: NodeJS.ErrnoException) => {
    end({ errorCode: typeof error.code === "string" ? error.code : "ERROR" });
  });
  child.once("close", (exitCode, signal) => end({ exitCode, signal }));
}

/** Records an awaited execution (execFile style) and rethrows its failure unchanged. */
export async function trackExecution<T>(launch: ProcessLaunch, run: () => Promise<T>): Promise<T> {
  const end = beginProcessLaunch(launch);
  if (!end) return run();
  try {
    const result = await run();
    end({ exitCode: 0 });
    return result;
  } catch (error) {
    end(outcomeOfFailure(error));
    throw error;
  }
}

function outcomeOfFailure(error: unknown): ProcessLaunchOutcome {
  const failure = error as { code?: unknown; signal?: unknown };
  const signal = typeof failure.signal === "string" ? failure.signal : null;
  // execFile reports a non-zero exit as a numeric code and a launch failure as a string code.
  if (typeof failure.code === "number") return { exitCode: failure.code, signal };
  return { errorCode: typeof failure.code === "string" ? failure.code : (signal ?? "ERROR") };
}
