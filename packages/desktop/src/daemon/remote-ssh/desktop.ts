import path from "node:path";
import { app, BrowserWindow } from "electron";
import { validatePort, validateSshHost } from "@pimi/protocol/ssh-transport";
import { resolveDesktopAppVersion } from "../app-version.js";
import { allowSshPrompts, answerSshAuth, forgetSshAuth } from "./askpass.js";
import { RemoteSshError } from "./errors.js";
import {
  ensureRemoteDaemon,
  type RemoteSshEnsureInput,
  type RemoteSshEnsureResult,
  type RemoteSshProgress,
  type RemoteSshUpgradePending,
} from "./installer.js";

const PROGRESS_EVENT = "pimi:event:remote-ssh-progress";
const UPGRADE_PENDING_EVENT = "pimi:event:remote-ssh-upgrade-pending";
// One prompt per machine and running version until the app restarts or the user upgrades.
const announcedUpgrades = new Set<string>();

export interface RemoteSshPrepareRequest {
  requestId: string;
  target: RemoteSshEnsureInput;
}

export type RemoteSshPrepareResponse =
  | { ok: true; result: RemoteSshEnsureResult }
  | { ok: false; code: string; message: string; detail: string | null };

const cancellations = new Map<string, AbortController>();

function broadcastProgress(requestId: string, progress: RemoteSshProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(PROGRESS_EVENT, { requestId, ...progress });
  }
}

/** Dev override for the bundle directory. Packaged builds always download from the release. */
function devBundleDir(): string | null {
  if (app.isPackaged) return null;
  return process.env.PIMI_REMOTE_DAEMON_BUNDLE_DIR?.trim() || null;
}

/** Same override for the version the remote must run, so an upgrade can be exercised in dev. */
function targetVersion(): string {
  if (!app.isPackaged) {
    const override = process.env.PIMI_REMOTE_DAEMON_VERSION?.trim();
    if (override) return override;
  }
  return resolveDesktopAppVersion();
}

function announceUpgradePending(pending: RemoteSshUpgradePending): void {
  const key = `${pending.host}|${pending.sshPort ?? ""}|${pending.daemonPort ?? ""}|${pending.runningVersion}`;
  if (announcedUpgrades.has(key)) return;
  announcedUpgrades.add(key);
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(UPGRADE_PENDING_EVENT, pending);
  }
}

export function ensureRemoteDaemonForDesktop(
  input: RemoteSshEnsureInput,
  options: { requestId?: string; signal?: AbortSignal } = {},
): Promise<RemoteSshEnsureResult> {
  const { requestId } = options;
  return ensureRemoteDaemon(input, {
    appVersion: targetVersion(),
    cacheDir: path.join(app.getPath("userData"), "remote-daemon"),
    devBundleDir: devBundleDir(),
    signal: options.signal,
    onProgress: requestId ? (progress) => broadcastProgress(requestId, progress) : undefined,
    onUpgradePending: announceUpgradePending,
  });
}

function parseEnsureInput(value: unknown): RemoteSshEnsureInput {
  if (typeof value !== "object" || value === null)
    throw new Error("Remote SSH target is required.");
  const record = value as Record<string, unknown>;
  const service =
    record.service === "systemd" || record.service === "nohup" ? record.service : undefined;
  const upgrade = record.upgrade === "now" ? "now" : undefined;
  return {
    host: validateSshHost(typeof record.host === "string" ? record.host : ""),
    ...(typeof record.sshPort === "number"
      ? { sshPort: validatePort(record.sshPort, "SSH port") }
      : {}),
    ...(typeof record.daemonPort === "number"
      ? { daemonPort: validatePort(record.daemonPort, "Daemon port") }
      : {}),
    ...(service ? { service } : {}),
    ...(upgrade ? { upgrade } : {}),
  };
}

/** IPC: install or upgrade and start the remote daemon, streaming progress events. */
export async function prepareRemoteSsh(args: unknown): Promise<RemoteSshPrepareResponse> {
  const record = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  const requestId = typeof record.requestId === "string" ? record.requestId : "";
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(requestId))
    throw new Error("Remote SSH request ID is invalid.");
  const controller = new AbortController();
  cancellations.set(requestId, controller);
  try {
    const input = parseEnsureInput(record.target);
    allowSshPrompts(input);
    const result = await ensureRemoteDaemonForDesktop(input, {
      requestId,
      signal: controller.signal,
    });
    return { ok: true, result };
  } catch (error) {
    if (error instanceof RemoteSshError) {
      return { ok: false, code: error.code, message: error.message, detail: error.detail };
    }
    return {
      ok: false,
      code: "SSH_FAILED",
      message: error instanceof Error ? error.message : String(error),
      detail: null,
    };
  } finally {
    cancellations.delete(requestId);
  }
}

export function cancelRemoteSsh(args: unknown): void {
  const requestId = (args as { requestId?: unknown } | null)?.requestId;
  if (typeof requestId === "string") cancellations.get(requestId)?.abort();
}

function parseAuthTarget(value: unknown): { host: string; sshPort?: number } {
  const input = parseEnsureInput(value);
  return { host: input.host, ...(input.sshPort !== undefined ? { sshPort: input.sshPort } : {}) };
}

/** IPC: the user's answer to an ssh sign-in prompt. The secret is never logged or stored. */
export function answerRemoteSshAuth(args: unknown): void {
  const record = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  if (typeof record.promptId !== "string") throw new Error("Prompt ID is required.");
  if (record.cancel === true) {
    answerSshAuth(record.promptId, "cancel");
    return;
  }
  if (typeof record.secret !== "string") throw new Error("Answer is required.");
  answerSshAuth(record.promptId, { secret: record.secret });
}

/** IPC: forget the passwords and the cancel mark for a machine whose connection was removed. */
export function forgetRemoteSshAuth(args: unknown): void {
  forgetSshAuth(parseAuthTarget(args));
}
