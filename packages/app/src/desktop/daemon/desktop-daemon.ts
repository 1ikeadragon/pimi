import { i18n } from "@/i18n/i18next";
import { confirmDialog } from "@/utils/confirm-dialog";
import { getDesktopHost, isElectronRuntime } from "@/desktop/host";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import type { AgentSkillSelection } from "@pimi/protocol/messages";

export type DesktopDaemonState = "starting" | "running" | "stopped" | "errored";
export type DesktopDaemonStopReason =
  | "manual_ipc"
  | "settings"
  | "host_remove"
  | "quit"
  | "app_update"
  | "version_mismatch"
  | "restart";

export interface DesktopDaemonStatus {
  serverId: string;
  status: DesktopDaemonState;
  listen: string | null;
  hostname: string | null;
  pid: number | null;
  home: string;
  version: string | null;
  desktopManaged: boolean;
  ownedByDesktop: boolean;
  startedAt: string | null;
  error: string | null;
}

export interface DesktopDaemonLogs {
  logPath: string;
  contents: string;
}

export interface DesktopAppLogs {
  logPath: string;
  contents: string;
}

export interface DesktopUpdaterDiagnosticFile {
  path: string;
  exists: boolean;
  modifiedAt: string | null;
  contents: string;
  error: string | null;
}

export interface DesktopUpdaterDiagnostics {
  platform: string;
  currentVersion: string;
  targetVersion: string | null;
  targetVersionError: string | null;
  shipItDirectory: string | null;
  state: DesktopUpdaterDiagnosticFile | null;
  stdout: DesktopUpdaterDiagnosticFile | null;
  stderr: DesktopUpdaterDiagnosticFile | null;
}

export interface LocalTransportTarget {
  [key: string]: unknown;
  transportType: "socket" | "pipe";
  transportPath: string;
}

export interface RemoteSshTransportTarget {
  [key: string]: unknown;
  transportType: "ssh";
  host: string;
  sshPort?: number;
  daemonPort?: number;
}

export type DesktopDaemonTransportTarget = LocalTransportTarget | RemoteSshTransportTarget;

export interface OpenLocalTransportSessionInput {
  [key: string]: unknown;
  sessionId: string;
  target: DesktopDaemonTransportTarget;
}

interface LocalTransportEventPayload {
  sessionId: string;
  kind: "open" | "message" | "close" | "error";
  text?: string | null;
  binaryBase64?: string | null;
  code?: number | null;
  reason?: string | null;
  error?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseDesktopDaemonState(value: unknown): DesktopDaemonState {
  const normalized = toStringOrNull(value)?.toLowerCase();
  switch (normalized) {
    case "starting":
      return "starting";
    case "running":
      return "running";
    case "errored":
    case "error":
      return "errored";
    case "stopped":
    case "stopping":
    case "unknown":
    default:
      return "stopped";
  }
}

function parseDesktopDaemonStatus(raw: unknown): DesktopDaemonStatus {
  if (!isRecord(raw)) {
    throw new Error("Unexpected desktop daemon status response.");
  }
  return {
    serverId: toStringOrNull(raw.serverId) ?? "",
    status: parseDesktopDaemonState(raw.status),
    listen: toStringOrNull(raw.listen),
    hostname: toStringOrNull(raw.hostname),
    pid: toNumberOrNull(raw.pid),
    home: toStringOrNull(raw.home) ?? "",
    version: toStringOrNull(raw.version),
    desktopManaged: raw.desktopManaged === true,
    ownedByDesktop: raw.ownedByDesktop === true,
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : null,
    error: toStringOrNull(raw.error),
  };
}

function parseDesktopDaemonLogs(raw: unknown): DesktopDaemonLogs {
  if (!isRecord(raw)) {
    throw new Error("Unexpected desktop daemon logs response.");
  }
  return {
    logPath: toStringOrNull(raw.logPath) ?? "",
    contents: typeof raw.contents === "string" ? raw.contents : "",
  };
}

function parseDesktopUpdaterDiagnosticFile(raw: unknown): DesktopUpdaterDiagnosticFile | null {
  if (raw === null) return null;
  if (!isRecord(raw)) {
    throw new Error("Unexpected desktop updater diagnostic file response.");
  }
  return {
    path: toStringOrNull(raw.path) ?? "",
    exists: raw.exists === true,
    modifiedAt: toStringOrNull(raw.modifiedAt),
    contents: typeof raw.contents === "string" ? raw.contents : "",
    error: toStringOrNull(raw.error),
  };
}

function parseDesktopUpdaterDiagnostics(raw: unknown): DesktopUpdaterDiagnostics {
  if (!isRecord(raw)) {
    throw new Error("Unexpected desktop updater diagnostics response.");
  }
  return {
    platform: toStringOrNull(raw.platform) ?? "unknown",
    currentVersion: toStringOrNull(raw.currentVersion) ?? "unknown",
    targetVersion: toStringOrNull(raw.targetVersion),
    targetVersionError: toStringOrNull(raw.targetVersionError),
    shipItDirectory: toStringOrNull(raw.shipItDirectory),
    state: parseDesktopUpdaterDiagnosticFile(raw.state),
    stdout: parseDesktopUpdaterDiagnosticFile(raw.stdout),
    stderr: parseDesktopUpdaterDiagnosticFile(raw.stderr),
  };
}

export function shouldUseDesktopDaemon(): boolean {
  return isElectronRuntime();
}

export async function getDesktopDaemonStatus(): Promise<DesktopDaemonStatus> {
  return parseDesktopDaemonStatus(await invokeDesktopCommand("desktop_daemon_status"));
}

export async function startDesktopDaemon(): Promise<DesktopDaemonStatus> {
  return parseDesktopDaemonStatus(await invokeDesktopCommand("start_desktop_daemon"));
}

export async function stopDesktopDaemon(
  reason: DesktopDaemonStopReason = "manual_ipc",
): Promise<DesktopDaemonStatus> {
  return parseDesktopDaemonStatus(await invokeDesktopCommand("stop_desktop_daemon", { reason }));
}

export async function confirmAndStopDesktopDaemon(): Promise<DesktopDaemonStatus | null> {
  const captured = await getDesktopDaemonStatus();
  if (!captured.pid || !captured.startedAt) return captured;
  const ownership = captured.ownedByDesktop
    ? i18n.t("desktop.daemon.lifecycle.ownedMessage")
    : i18n.t("desktop.daemon.lifecycle.attachedMessage");
  const confirmed = await confirmDialog({
    title: i18n.t("desktop.daemon.lifecycle.stopTitle"),
    message: i18n.t("desktop.daemon.lifecycle.stopMessage", {
      ownership,
      home: captured.home,
      pid: captured.pid,
    }),
    confirmLabel: i18n.t("desktop.daemon.lifecycle.stop"),
    cancelLabel: i18n.t("common.actions.cancel"),
    destructive: true,
  });
  if (!confirmed) return null;
  return parseDesktopDaemonStatus(
    await invokeDesktopCommand("stop_desktop_daemon", {
      reason: "manual_ipc",
      pid: captured.pid,
      startedAt: captured.startedAt,
    }),
  );
}

/**
 * Replaces the running local daemon with the one bundled in this app once the user confirms.
 * Resolves to null when they cancel.
 */
export async function confirmAndRestartDesktopDaemonOnAppVersion(
  appVersion: string,
): Promise<DesktopDaemonStatus | null> {
  const captured = await getDesktopDaemonStatus();
  if (captured.pid && captured.startedAt) {
    const confirmed = await confirmDialog({
      title: i18n.t("desktop.daemon.versionCallout.confirmTitle"),
      message: i18n.t("desktop.daemon.versionCallout.confirmMessage", {
        appVersion,
        home: captured.home,
        pid: captured.pid,
      }),
      confirmLabel: i18n.t("desktop.daemon.versionCallout.restart"),
      cancelLabel: i18n.t("common.actions.cancel"),
      destructive: true,
    });
    if (!confirmed) return null;
    await invokeDesktopCommand("stop_desktop_daemon", {
      reason: "version_mismatch",
      pid: captured.pid,
      startedAt: captured.startedAt,
    });
  }
  return startDesktopDaemon();
}

export async function restartDesktopDaemon(): Promise<DesktopDaemonStatus> {
  return parseDesktopDaemonStatus(await invokeDesktopCommand("restart_desktop_daemon"));
}

export async function getDesktopDaemonLogs(): Promise<DesktopDaemonLogs> {
  return parseDesktopDaemonLogs(await invokeDesktopCommand("desktop_daemon_logs"));
}

export async function getDesktopAppLogs(): Promise<DesktopAppLogs> {
  const raw = await invokeDesktopCommand("desktop_app_logs");
  if (!isRecord(raw)) {
    throw new Error("Unexpected desktop app logs response.");
  }
  return {
    logPath: toStringOrNull(raw.logPath) ?? "",
    contents: typeof raw.contents === "string" ? raw.contents : "",
  };
}

export async function getDesktopUpdaterDiagnostics(): Promise<DesktopUpdaterDiagnostics> {
  return parseDesktopUpdaterDiagnostics(await invokeDesktopCommand("desktop_update_diagnostics"));
}

export async function getCliDaemonStatus(): Promise<string> {
  const raw = await invokeDesktopCommand<unknown>("cli_daemon_status");
  if (typeof raw !== "string") {
    throw new Error("Unexpected CLI daemon status response.");
  }
  return raw;
}

export type RemoteSshStep = "connecting" | "checking" | "installing" | "starting" | "connected";

export interface RemoteSshProgress {
  requestId: string;
  step: RemoteSshStep;
  message: string;
  fraction?: number;
}

export interface RemoteSshSetupTarget {
  [key: string]: unknown;
  host: string;
  sshPort?: number;
  daemonPort?: number;
  service?: "nohup" | "systemd";
  upgrade?: "now";
}

export type RemoteSshSetupResult =
  | {
      ok: true;
      result: {
        version: string;
        action: "ready" | "started" | "installed" | "upgraded";
        service: "nohup" | "systemd";
        systemdAvailable: boolean;
      };
    }
  | { ok: false; code: string; message: string; detail: string | null };

/** Installs or upgrades the daemon on a remote dev machine over ssh and starts it. */
export async function prepareRemoteSsh(input: {
  requestId: string;
  target: RemoteSshSetupTarget;
}): Promise<RemoteSshSetupResult> {
  return (await invokeDesktopCommand("remote_ssh_prepare", input)) as RemoteSshSetupResult;
}

/**
 * Opens (or reuses) a local socket on this desktop whose connections tunnel over ssh to that
 * machine's daemon. Returns the `unix://` or `pipe://` connection string a daemon can register.
 */
export async function ensureRemoteSshAgentEndpoint(target: {
  host: string;
  sshPort?: number;
  daemonPort?: number;
}): Promise<string> {
  const connection = await invokeDesktopCommand("remote_ssh_agent_endpoint", { ...target });
  if (typeof connection !== "string" || connection.length === 0) {
    throw new Error("Desktop returned no SSH agent endpoint.");
  }
  return connection;
}

/** Closes the socket opened by `ensureRemoteSshAgentEndpoint` and kills its tunnels. */
export async function closeRemoteSshAgentEndpoint(target: {
  host: string;
  sshPort?: number;
  daemonPort?: number;
}): Promise<void> {
  await invokeDesktopCommand("remote_ssh_agent_endpoint_close", { ...target });
}

export interface RemoteSshUpgradePending {
  host: string;
  sshPort?: number;
  daemonPort?: number;
  runningVersion: string;
  desktopVersion: string;
  busyAgents: number;
  terminals: number;
  unknown: boolean;
}

/** A saved remote machine runs another daemon version and has work the upgrade would stop. */
export async function listenToRemoteSshUpgradePending(
  handler: (pending: RemoteSshUpgradePending) => void,
): Promise<() => void> {
  const listen = getDesktopHost()?.events?.on;
  if (typeof listen !== "function") return () => {};
  const unlisten = await listen("remote-ssh-upgrade-pending", (payload: unknown) => {
    if (!isRecord(payload) || typeof payload.host !== "string") return;
    handler(payload as unknown as RemoteSshUpgradePending);
  });
  return typeof unlisten === "function" ? unlisten : () => {};
}

export interface RemoteSshAuthRequest {
  promptId: string;
  host: string;
  prompt: string;
  retry: boolean;
}

function parseRemoteSshAuthRequest(value: unknown): RemoteSshAuthRequest | null {
  if (
    !isRecord(value) ||
    typeof value.promptId !== "string" ||
    typeof value.host !== "string" ||
    typeof value.prompt !== "string"
  ) {
    return null;
  }
  return {
    promptId: value.promptId,
    host: value.host,
    prompt: value.prompt,
    retry: value.retry === true,
  };
}

/** Prompts that ssh opened before the listener below was attached. */
export async function listPendingRemoteSshAuth(): Promise<RemoteSshAuthRequest[]> {
  const raw = await invokeDesktopCommand<unknown>("remote_ssh_auth_pending");
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => parseRemoteSshAuthRequest(item) ?? []);
}

/** ssh asked for a password, passphrase or code. Answer with answerRemoteSshAuth. */
export async function listenToRemoteSshAuthRequests(handlers: {
  onRequest: (request: RemoteSshAuthRequest) => void;
  onDismiss: (promptId: string) => void;
}): Promise<() => void> {
  const listen = getDesktopHost()?.events?.on;
  if (typeof listen !== "function") return () => {};
  const stopRequests = await listen("remote-ssh-auth-request", (payload: unknown) => {
    const request = parseRemoteSshAuthRequest(payload);
    if (request) handlers.onRequest(request);
  });
  const stopDismiss = await listen("remote-ssh-auth-dismiss", (payload: unknown) => {
    if (isRecord(payload) && typeof payload.promptId === "string") {
      handlers.onDismiss(payload.promptId);
    }
  });
  return () => {
    if (typeof stopRequests === "function") stopRequests();
    if (typeof stopDismiss === "function") stopDismiss();
  };
}

export async function answerRemoteSshAuth(
  promptId: string,
  answer: { secret: string } | { cancel: true },
): Promise<void> {
  await invokeDesktopCommand("remote_ssh_auth_answer", { promptId, ...answer });
}

/** The machine's connection was removed: drop its remembered passwords. */
export async function forgetRemoteSshAuth(target: {
  host: string;
  sshPort?: number;
}): Promise<void> {
  await invokeDesktopCommand("remote_ssh_auth_forget", target);
}

export async function cancelRemoteSshSetup(requestId: string): Promise<void> {
  await invokeDesktopCommand("remote_ssh_cancel", { requestId });
}

export async function listenToRemoteSshProgress(
  handler: (progress: RemoteSshProgress) => void,
): Promise<() => void> {
  const listen = getDesktopHost()?.events?.on;
  if (typeof listen !== "function") return () => {};
  const unlisten = await listen("remote-ssh-progress", (payload: unknown) => {
    if (!isRecord(payload) || typeof payload.requestId !== "string") return;
    handler({
      requestId: payload.requestId,
      step: payload.step as RemoteSshStep,
      message: typeof payload.message === "string" ? payload.message : "",
      ...(typeof payload.fraction === "number" ? { fraction: payload.fraction } : {}),
    });
  });
  return typeof unlisten === "function" ? unlisten : () => {};
}

export interface RemoteSshUninstallTarget {
  [key: string]: unknown;
  host: string;
  sshPort?: number;
  daemonPort?: number;
}

/** What is on the remote machine, for the uninstall sheet. Null counts mean "could not be read". */
export interface RemoteSshUninstallCheck {
  daemonVersion: string | null;
  foreignDaemon: boolean;
  busyAgents: number | null;
  terminals: number | null;
  systemdUnit: boolean;
  runtimeKb: number | null;
  dataKb: number | null;
  worktrees: number;
}

export type RemoteSshUninstallStep = "connecting" | "stopping" | "removing" | "done";
export type RemoteSshUninstalled = "service" | "daemon" | "terminals" | "runtime" | "data";
export type RemoteSshKept = "data" | "foreignDaemon";

export interface RemoteSshUninstallResult {
  removed: RemoteSshUninstalled[];
  kept: RemoteSshKept[];
  serviceWarning: boolean;
}

export interface RemoteSshUninstallFailure {
  ok: false;
  code: string;
  message: string;
  detail: string | null;
}

/** Looks at the remote machine without changing it. Cancel with cancelRemoteSshSetup. */
export async function checkRemoteSshUninstall(input: {
  requestId: string;
  target: RemoteSshUninstallTarget;
}): Promise<{ ok: true; check: RemoteSshUninstallCheck } | RemoteSshUninstallFailure> {
  return (await invokeDesktopCommand("remote_ssh_uninstall_check", input)) as
    | { ok: true; check: RemoteSshUninstallCheck }
    | RemoteSshUninstallFailure;
}

/** Stops the daemon and removes Pimi from the remote machine. Cancel with cancelRemoteSshSetup. */
export async function uninstallRemoteSsh(input: {
  requestId: string;
  target: RemoteSshUninstallTarget;
  deleteData: boolean;
}): Promise<{ ok: true; result: RemoteSshUninstallResult } | RemoteSshUninstallFailure> {
  return (await invokeDesktopCommand("remote_ssh_uninstall", input)) as
    | { ok: true; result: RemoteSshUninstallResult }
    | RemoteSshUninstallFailure;
}

export async function listenToRemoteSshUninstallProgress(
  handler: (progress: { requestId: string; step: RemoteSshUninstallStep; message: string }) => void,
): Promise<() => void> {
  const listen = getDesktopHost()?.events?.on;
  if (typeof listen !== "function") return () => {};
  const unlisten = await listen("remote-ssh-uninstall-progress", (payload: unknown) => {
    if (!isRecord(payload) || typeof payload.requestId !== "string") return;
    handler({
      requestId: payload.requestId,
      step: payload.step as RemoteSshUninstallStep,
      message: typeof payload.message === "string" ? payload.message : "",
    });
  });
  return typeof unlisten === "function" ? unlisten : () => {};
}

export type LocalTransportEventUnlisten = () => void;
export type LocalTransportEventHandler = (payload: LocalTransportEventPayload) => void;

export async function listenToLocalTransportEvents(
  handler: LocalTransportEventHandler,
): Promise<LocalTransportEventUnlisten> {
  const listen = getDesktopHost()?.events?.on;
  if (typeof listen !== "function") {
    throw new Error("Desktop events API is unavailable.");
  }
  const unlisten = await listen("local-daemon-transport-event", (payload: unknown) => {
    if (!isRecord(payload)) {
      return;
    }
    handler({
      sessionId: toStringOrNull(payload.sessionId) ?? "",
      kind: (toStringOrNull(payload.kind) ?? "error") as LocalTransportEventPayload["kind"],
      text: toStringOrNull(payload.text),
      binaryBase64: toStringOrNull(payload.binaryBase64),
      code: toNumberOrNull(payload.code),
      reason: toStringOrNull(payload.reason),
      error: toStringOrNull(payload.error),
    });
  });
  return typeof unlisten === "function" ? unlisten : () => {};
}

export async function openLocalTransportSession(
  input: OpenLocalTransportSessionInput,
): Promise<void> {
  await invokeDesktopCommand("open_local_daemon_transport", input);
}

export async function sendLocalTransportMessage(input: {
  sessionId: string;
  text?: string;
  binaryBase64?: string;
}): Promise<void> {
  await invokeDesktopCommand("send_local_daemon_transport_message", {
    sessionId: input.sessionId,
    ...(input.text ? { text: input.text } : {}),
    ...(input.binaryBase64 ? { binaryBase64: input.binaryBase64 } : {}),
  });
}

export async function closeLocalTransportSession(sessionId: string): Promise<void> {
  await invokeDesktopCommand("close_local_daemon_transport", { sessionId });
}

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

export interface InstallStatus {
  installed: boolean;
}

function parseInstallStatus(raw: unknown): InstallStatus {
  if (!isRecord(raw)) {
    throw new Error("Unexpected install status response.");
  }
  return { installed: raw.installed === true };
}

export async function getCliInstallStatus(): Promise<InstallStatus> {
  return parseInstallStatus(await invokeDesktopCommand("get_cli_install_status"));
}

export async function installCli(): Promise<InstallStatus> {
  return parseInstallStatus(await invokeDesktopCommand("install_cli"));
}

export async function uninstallCli(): Promise<InstallStatus> {
  return parseInstallStatus(await invokeDesktopCommand("uninstall_cli"));
}

// COMPAT(desktopSkillSelectionMigration): added in v0.4.0; remove after 2027-02-16.
export function readLegacySkillSelection(): Promise<AgentSkillSelection | null> {
  return invokeDesktopCommand("read_legacy_skill_selection") as Promise<AgentSkillSelection | null>;
}

// COMPAT(desktopSkillSelectionMigration): added in v0.4.0; remove after 2027-02-16.
export async function deleteLegacySkillSelection(): Promise<void> {
  await invokeDesktopCommand("delete_legacy_skill_selection");
}

export interface DesktopSandboxDiagnostics {
  enabled: boolean;
  reason: string;
}

export async function getDesktopSandboxDiagnostics(): Promise<DesktopSandboxDiagnostics> {
  const result: unknown = await invokeDesktopCommand("desktop_sandbox_diagnostics");
  if (
    !isRecord(result) ||
    typeof result.enabled !== "boolean" ||
    typeof result.reason !== "string"
  ) {
    throw new Error("Unexpected desktop sandbox diagnostics response.");
  }
  return { enabled: result.enabled, reason: result.reason };
}
