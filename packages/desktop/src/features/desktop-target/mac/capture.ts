import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeImage } from "electron";

// One window by its window-server id, not the whole screen: `screencapture -l` reads that window
// even when other windows cover it, and costs one small PNG instead of a thumbnail of every
// window that desktopCapturer would build. Needs Screen Recording for the app that spawned it.

const MAX_WIDTH = 1280;
const execFileAsync = promisify(execFile);
let chain: Promise<unknown> = Promise.resolve();

export interface CapturedWindow {
  dataBase64: string;
  width: number;
  height: number;
}

async function captureNow(windowNumber: number, maxWidth: number): Promise<CapturedWindow> {
  const dir = await mkdtemp(join(tmpdir(), "pimi-desktop-target-"));
  const file = join(dir, "window.png");
  try {
    await execFileAsync(
      "/usr/sbin/screencapture",
      ["-l", String(windowNumber), "-x", "-o", "-t", "png", file],
      { timeout: 5_000 },
    );
    const raw = nativeImage.createFromBuffer(await readFile(file));
    if (raw.isEmpty()) throw new Error("The window capture was empty.");
    const size = raw.getSize();
    const limit = Math.min(Math.max(64, Math.floor(maxWidth)), MAX_WIDTH);
    const image = size.width > limit ? raw.resize({ width: limit, quality: "good" }) : raw;
    const out = image.getSize();
    return { dataBase64: image.toPNG().toString("base64"), width: out.width, height: out.height };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Captures run one at a time so a slow window never stacks frames. */
export function captureWindow(windowNumber: number, maxWidth: number): Promise<CapturedWindow> {
  const job = chain.then(() => captureNow(windowNumber, maxWidth));
  chain = job.catch(() => undefined);
  return job;
}
