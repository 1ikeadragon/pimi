import type { DaemonClient } from "@pimi/client/internal/daemon-client";

// Commands that stream until stopped (`pimi agent logs --follow`, `pimi agent
// attach`) stop on Ctrl+C, a termination signal, or when the program reading
// their output closes its end, as `| head` does. A closed reader shows up as
// EPIPE on the next write to stdout, so the command stops at its next line of
// output.
export function waitForStop(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => {
      signal?.removeEventListener("abort", stop);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      process.stdout.off("error", stopOnClosedStdout);
      resolve();
    };
    const stopOnClosedStdout = (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE") {
        stop();
      }
    };

    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    process.stdout.on("error", stopOnClosedStdout);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
  });
}

// The CLI client does not reconnect, so a closed socket would otherwise empty the event loop and
// exit silently. Rejects when the daemon connection drops before `stopped` settles.
export async function stopOrConnectionLoss(
  stopped: Promise<void>,
  client: DaemonClient,
): Promise<void> {
  let unsubscribe = () => {};
  const lost = new Promise<never>((_, reject) => {
    unsubscribe = client.subscribeConnectionStatus((status) => {
      if (status.status === "disconnected" || status.status === "disposed") {
        reject(new Error("Connection to the daemon was lost"));
      }
    });
  });
  try {
    await Promise.race([stopped, lost]);
  } finally {
    unsubscribe();
  }
}
