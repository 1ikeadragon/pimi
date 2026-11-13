import { watch } from "node:fs";

const SETTLE_MS = 400;

/**
 * Calls `onChange` once a burst of changes under `cwd` settles. Changes inside `.git` are ignored:
 * git rewrites it on every status. Resolves when `signal` aborts.
 */
export async function watchRepository(
  cwd: string,
  signal: AbortSignal,
  onChange: () => void,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const watcher = watch(cwd, { recursive: true }, (_event, name) => {
    if (name && (name === ".git" || name.startsWith(".git/") || name.startsWith(".git\\"))) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, SETTLE_MS);
  });
  try {
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
  } finally {
    if (timer) clearTimeout(timer);
    watcher.close();
  }
}
