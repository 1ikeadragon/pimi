import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

interface AtomicFileRuntime {
  platform: NodeJS.Platform;
  rename: (source: string, destination: string) => Promise<void>;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}

const runtime: AtomicFileRuntime = {
  platform: process.platform,
  rename: fs.rename,
  now: () => performance.now(),
  sleep,
};

export async function writeFileAtomic(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
  operations: AtomicFileRuntime = runtime,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  try {
    await writeAndSync(tempPath, data);
    await replaceFile(tempPath, filePath, operations);
    await syncDirectory(path.dirname(filePath), operations.platform);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

// Flush the temp file before the rename so a power loss cannot leave the new name pointing at
// empty or partial contents.
async function writeAndSync(
  tempPath: string,
  data: string | NodeJS.ArrayBufferView,
): Promise<void> {
  const handle = await fs.open(tempPath, "w");
  try {
    if (typeof data === "string") await handle.writeFile(data, "utf8");
    else await handle.writeFile(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Flush the directory entry so the rename itself survives a power loss. Windows cannot open a
// directory for sync, and some filesystems reject it; the file contents are already durable then.
async function syncDirectory(directory: string, platform: NodeJS.Platform): Promise<void> {
  if (platform === "win32") return;
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch {
    // Best effort: the rename already happened.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function replaceFile(
  source: string,
  destination: string,
  operations: AtomicFileRuntime,
): Promise<void> {
  // Windows readers/scanners can briefly deny replacement. Yield with backoff,
  // but keep interactive persistence failures bounded to a one-second retry budget.
  const deadline = operations.now() + 1000;
  let delay = 10;
  for (;;) {
    try {
      await operations.rename(source, destination);
      return;
    } catch (error) {
      if (
        operations.platform !== "win32" ||
        !(error instanceof Error) ||
        !("code" in error) ||
        !["EPERM", "EACCES", "EBUSY"].includes(String(error.code))
      ) {
        throw error;
      }
      const remaining = deadline - operations.now();
      if (remaining <= 0) throw error;
      await operations.sleep(Math.min(delay, remaining));
      if (operations.now() >= deadline) throw error;
      delay = Math.min(delay * 2, 100);
    }
  }
}

export async function writeJsonFileAtomic(
  filePath: string,
  value: unknown,
  operations: AtomicFileRuntime = runtime,
): Promise<void> {
  await writeFileAtomic(filePath, JSON.stringify(value, null, 2), operations);
}
