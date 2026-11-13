import path from "node:path";
import { app, BrowserWindow } from "electron";
import { validatePort, validateSshHost } from "@pimi/protocol/ssh-transport";
import { resolveDesktopAppVersion } from "../app-version.js";
import { allowSshPrompts, answerSshAuth, forgetSshAuth } from "./askpass.js";
import { RemoteSshError } from "./errors.js";
import {
  checkRemoteUninstall,
  uninstallRemoteDaemon,
  type RemoteUninstallCheck,
  type RemoteUninstallProgress,
  type RemoteUninstallResult,
} from "./uninstall.js";
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

// The runtime under ~/.pimi is shared by every daemon port on a machine, so the mark is per
// machine (host + ssh port), like the sign-in cache.
const machineKey = (target: { host: string; sshPort?: number }): string =>
  `${target.host}|${target.sshPort ?? ""}`;
// Machines being uninstalled. Every connect runs the installer, so without this the app's
// reconnect would reinstall and restart the daemon the moment uninstall stops it. Cleared on a
// failed or cancelled uninstall and when the machine is added again; a finished uninstall keeps
// it, because the host is removed right after.
const uninstalling = new Set<string>();
// Setups in flight per machine, so an uninstall can stop them before it starts.
const ensuring = new Map<string, Map<Promise<unknown>, AbortController>>();

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
  const key = machineKey(input);
  if (uninstalling.has(key)) {
    return Promise.reject(
      new RemoteSshError(
        "UNINSTALLING",
        `Pimi is being removed from ${input.host}, so it is not reconnecting.`,
      ),
    );
  }
  const controller = new AbortController();
  options.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  if (options.signal?.aborted) controller.abort();
  const run = ensureRemoteDaemon(input, {
    appVersion: targetVersion(),
    cacheDir: path.join(app.getPath("userData"), "remote-daemon"),
    devBundleDir: devBundleDir(),
    signal: controller.signal,
    onProgress: requestId ? (progress) => broadcastProgress(requestId, progress) : undefined,
    onUpgradePending: announceUpgradePending,
  });
  const running = ensuring.get(key) ?? new Map<Promise<unknown>, AbortController>();
  ensuring.set(key, running);
  running.set(run, controller);
  const forget = () => {
    running.delete(run);
    if (running.size === 0 && ensuring.get(key) === running) ensuring.delete(key);
  };
  run.then(forget, forget);
  return run;
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
    // Adding a machine again after an uninstall.
    uninstalling.delete(machineKey(input));
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

const UNINSTALL_PROGRESS_EVENT = "pimi:event:remote-ssh-uninstall-progress";

export type RemoteSshUninstallCheckResponse =
  | { ok: true; check: RemoteUninstallCheck }
  | RemoteSshFailure;
export type RemoteSshUninstallResponse =
  | { ok: true; result: RemoteUninstallResult }
  | RemoteSshFailure;
interface RemoteSshFailure {
  ok: false;
  code: string;
  message: string;
  detail: string | null;
}

function failureOf(error: unknown): RemoteSshFailure {
  if (error instanceof RemoteSshError) {
    return { ok: false, code: error.code, message: error.message, detail: error.detail };
  }
  return {
    ok: false,
    code: "SSH_FAILED",
    message: error instanceof Error ? error.message : String(error),
    detail: null,
  };
}

function parseRequestId(record: Record<string, unknown>): string {
  const requestId = typeof record.requestId === "string" ? record.requestId : "";
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(requestId))
    throw new Error("Remote SSH request ID is invalid.");
  return requestId;
}

function broadcastUninstallProgress(requestId: string, progress: RemoteUninstallProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(UNINSTALL_PROGRESS_EVENT, { requestId, ...progress });
  }
}

/** IPC: look at what uninstalling would remove, without changing the remote machine. */
export async function checkRemoteSshUninstall(
  args: unknown,
): Promise<RemoteSshUninstallCheckResponse> {
  const record = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  const requestId = parseRequestId(record);
  const controller = new AbortController();
  cancellations.set(requestId, controller);
  try {
    const target = parseEnsureInput(record.target);
    allowSshPrompts(target);
    return { ok: true, check: await checkRemoteUninstall(target, { signal: controller.signal }) };
  } catch (error) {
    return failureOf(error);
  } finally {
    cancellations.delete(requestId);
  }
}

/**
 * IPC: stop the daemon and remove Pimi from the remote machine. The machine is marked first so
 * the app's own reconnect cannot reinstall the daemon, and setups already running are cancelled.
 */
export async function uninstallRemoteSsh(args: unknown): Promise<RemoteSshUninstallResponse> {
  const record = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  const requestId = parseRequestId(record);
  const controller = new AbortController();
  cancellations.set(requestId, controller);
  let key: string | null = null;
  try {
    const target = parseEnsureInput(record.target);
    key = machineKey(target);
    uninstalling.add(key);
    allowSshPrompts(target);
    const running = ensuring.get(key);
    if (running) {
      for (const setup of running.values()) setup.abort();
      await Promise.allSettled(running.keys());
    }
    const result = await uninstallRemoteDaemon(target, {
      deleteData: record.deleteData === true,
      signal: controller.signal,
      onProgress: (progress) => broadcastUninstallProgress(requestId, progress),
    });
    return { ok: true, result };
  } catch (error) {
    if (key) uninstalling.delete(key);
    return failureOf(error);
  } finally {
    cancellations.delete(requestId);
  }
}
