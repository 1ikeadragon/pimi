import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import type { DesktopTargetErrorCode } from "@pimi/protocol/desktop-target/rpc-schemas";

// One long-lived pimi-desktop-helper.exe, spoken to in JSON lines (HELPER-CONTRACT.md in the
// design notes, and the comments in native/win). It starts on the first request, answers one
// request at a time, and is killed and started again when a request times out or it exits.

export interface HelperTarget {
  appId: string;
  windowTitle: string;
  hwnd: string | null;
  pid: number | null;
  processStartedAt: string | null;
  windowClass: string | null;
  allowInput: boolean;
  allowRelaunch: boolean;
  launchArgs: string;
  disposable: boolean;
}

export interface HelperRequest {
  verb: string;
  agent: string | null;
  target: HelperTarget | null;
  args: Record<string, unknown>;
}

export class HelperError extends Error {
  constructor(
    public readonly code: DesktopTargetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HelperError";
  }
}

const HELPER_NAME = "pimi-desktop-helper.exe";
const REQUEST_TIMEOUT_MS = 10_000;
const WAIT_TIMEOUT_MS = 15_000;
// Launch waits up to 15 s for the window to appear.
const APP_TIMEOUT_MS = 25_000;

export function helperPath(): string {
  const dir = app.isPackaged
    ? path.join(process.resourcesPath, "desktop-helper")
    : path.resolve(__dirname, "../../../../native/win/bin");
  return path.join(dir, HELPER_NAME);
}

type Reply =
  | { id: string; ok: true; result: Record<string, unknown> }
  | { id: string; ok: false; code: string; message: string };

interface Waiting {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let child: ChildProcessWithoutNullStreams | null = null;
let buffer = "";
let nextId = 0;
const waiting = new Map<string, Waiting>();
let queue: Promise<unknown> = Promise.resolve();

function failAll(error: Error): void {
  for (const [id, entry] of waiting) {
    clearTimeout(entry.timer);
    waiting.delete(id);
    entry.reject(error);
  }
}

function onLine(line: string): void {
  if (line.trim() === "") return;
  let reply: Reply;
  try {
    reply = JSON.parse(line) as Reply;
  } catch {
    return;
  }
  const entry = waiting.get(reply.id);
  if (!entry) return;
  waiting.delete(reply.id);
  clearTimeout(entry.timer);
  if (reply.ok) entry.resolve(reply.result);
  else entry.reject(new HelperError(reply.code as DesktopTargetErrorCode, reply.message));
}

function start(): ChildProcessWithoutNullStreams {
  if (child) return child;
  const exe = helperPath();
  if (!existsSync(exe)) {
    throw new HelperError(
      "failed",
      "The Windows desktop helper is missing. Reinstall Pimi, or run npm run build:win-helper in a checkout.",
    );
  }
  const spawned = spawn(exe, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  buffer = "";
  spawned.stdout.setEncoding("utf8");
  spawned.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      onLine(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
  });
  // The helper's diagnostics never hold typed text or titles; drained so the pipe never fills.
  spawned.stderr.on("data", () => undefined);
  spawned.stdin.on("error", () => undefined);
  const gone = (reason: string) => {
    if (child === spawned) child = null;
    failAll(new HelperError("failed", `The desktop helper ${reason}.`));
  };
  spawned.on("error", (error) => gone(`could not start (${error.message})`));
  spawned.on("exit", (code) => gone(`exited (code ${code ?? "none"})`));
  child = spawned;
  return spawned;
}

function kill(): void {
  const current = child;
  child = null;
  current?.kill();
}

function timeoutFor(verb: string, args: Record<string, unknown>): number {
  if (verb === "wait") return WAIT_TIMEOUT_MS;
  if (verb === "app" && args.action !== "status") return APP_TIMEOUT_MS;
  return REQUEST_TIMEOUT_MS;
}

function send(request: HelperRequest): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = start();
    } catch (error) {
      reject(error);
      return;
    }
    nextId += 1;
    const id = String(nextId);
    const ms = timeoutFor(request.verb, request.args);
    const timer = setTimeout(() => {
      waiting.delete(id);
      // A stuck helper may hold keys down: killing it releases them, and the next request starts a
      // fresh one.
      kill();
      reject(
        new HelperError(
          "failed",
          `The desktop helper did not answer within ${ms} ms and was restarted.`,
        ),
      );
    }, ms);
    waiting.set(id, { resolve, reject, timer });
    proc.stdin.write(`${JSON.stringify({ id, ...request })}\n`, (error) => {
      if (!error) return;
      const entry = waiting.get(id);
      if (!entry) return;
      waiting.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new HelperError("failed", "The desktop helper could not be written to."));
    });
  });
}

/** Runs one request. Requests are answered in order, one at a time. */
export function helperRequest(request: HelperRequest): Promise<Record<string, unknown>> {
  const job = queue.then(() => send(request));
  queue = job.catch(() => undefined);
  return job;
}

/** Ends the helper (it releases any keys it holds when stdin closes). */
export function stopHelper(): void {
  const current = child;
  child = null;
  if (!current) return;
  current.stdin.end();
  setTimeout(() => current.kill(), 500).unref();
}
