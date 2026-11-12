import { readFileSync } from "node:fs";
import path from "node:path";
import { app, ipcMain, powerMonitor } from "electron";
import log from "electron-log/main";
import {
  PIMI_LOCAL_PAIRING_ROUTE,
  PimiLocalPairingRequest,
  PimiLocalPairingStatus,
} from "@pimi/protocol/connection-offer";
import { parseHostPort } from "@pimi/protocol/daemon-endpoints";
import {
  resolvePimiHome,
  startDaemonInstance,
  DaemonInstanceError,
  stopDaemonInstance,
  readDaemonInstance,
  isSameDaemonInstance,
  readLocalCredentialForTarget,
  type DaemonInstance,
} from "@pimi/server/daemon-control";
import {
  copyAttachmentFileToManagedStorage,
  deleteManagedAttachmentFile,
  garbageCollectManagedAttachmentFiles,
  readManagedFileBase64,
  writeAttachmentBase64,
  writeAttachmentBytes,
} from "../features/attachments.js";
import {
  checkForAppUpdate,
  downloadAndInstallUpdate,
  type AppUpdateCheckIntent,
  type AppReleaseChannel,
} from "../features/auto-updater.js";
import {
  getBundledCliShimPath,
  getCliInstallStatus,
  installCli,
  uninstallCli,
} from "../integrations/cli-install/index.js";
import {
  openLocalTransportSession,
  sendLocalTransportMessage,
  closeLocalTransportSession,
} from "./local-transport.js";
import { createNodeEntrypointInvocation, resolveDaemonRunnerEntrypoint } from "./runtime-paths.js";
import { runExternalCliJsonCommand, runExternalCliTextCommand } from "./cli/external.js";
import {
  createDesktopSettingsCommandHandlers,
  type DesktopCommandHandler,
} from "../settings/desktop-settings-commands.js";
import type { DesktopSettings } from "../settings/desktop-settings.js";
import { getDesktopSettingsStore } from "../settings/desktop-settings-electron.js";
import { isRunningUnderARM64Translation } from "../system/arm64-translation.js";
import { describeSandbox } from "../diagnostics/sandbox.js";
import { getDesktopAppLogs } from "../diagnostics/app-logs.js";
import { getDesktopUpdaterDiagnostics } from "../diagnostics/updater.js";
import {
  deleteLegacySkillSelection,
  readLegacySkillSelection,
} from "../integrations/legacy-skill-selection.js";
import { tailFile } from "../diagnostics/tail-file.js";

const DAEMON_LOG_FILENAME = "daemon.log";
let ownedLaunch: { home: string; instance: DaemonInstance } | null = null;

type DesktopDaemonState = "starting" | "running" | "stopped" | "errored";
const DESKTOP_DAEMON_STOP_REASON_VALUES = [
  "manual_ipc",
  "settings",
  "host_remove",
  "quit",
  "app_update",
  "version_mismatch",
  "restart",
] as const;
export type DesktopDaemonStopReason = (typeof DESKTOP_DAEMON_STOP_REASON_VALUES)[number];

const DESKTOP_DAEMON_STOP_REASONS = new Set<string>(DESKTOP_DAEMON_STOP_REASON_VALUES);
const DEFAULT_DESKTOP_DAEMON_STOP_REASON: DesktopDaemonStopReason = "manual_ipc";

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

interface DesktopDaemonLogs {
  logPath: string;
  contents: string;
}

function parseReleaseChannel(
  args: Record<string, unknown> | undefined,
): AppReleaseChannel | undefined {
  if (args?.releaseChannel === "beta") {
    return "beta";
  }
  if (args?.releaseChannel === "stable") {
    return "stable";
  }
  return undefined;
}

function parseAppUpdateCheckIntent(
  args: Record<string, unknown> | undefined,
): AppUpdateCheckIntent {
  return args?.intent === "manual" ? "manual" : "automatic";
}

function parseDesktopDaemonStopReason(
  args: Record<string, unknown> | undefined,
): DesktopDaemonStopReason {
  const reason = args?.reason;
  if (typeof reason === "string" && DESKTOP_DAEMON_STOP_REASONS.has(reason)) {
    return reason as DesktopDaemonStopReason;
  }
  return DEFAULT_DESKTOP_DAEMON_STOP_REASON;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function getPimiHome(): string {
  return resolvePimiHome(process.env);
}

function logFilePath(): string {
  return path.join(getPimiHome(), DAEMON_LOG_FILENAME);
}

export function isDesktopManagedDaemonRunningSync(): boolean {
  if (!ownedLaunch) return false;
  try {
    const lock = JSON.parse(readFileSync(path.join(ownedLaunch.home, "paseo.pid"), "utf8"));
    return isSameDaemonInstance(lock, ownedLaunch.instance) && isProcessRunning(lock.pid);
  } catch {
    return false;
  }
}

export async function stopDesktopDaemonViaCli(
  reason: DesktopDaemonStopReason = DEFAULT_DESKTOP_DAEMON_STOP_REASON,
): Promise<void> {
  await stopDesktopDaemon(reason);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "EPERM") {
      return true;
    }
    return false;
  }
}

function logDesktopDaemonLifecycle(message: string, details?: Record<string, unknown>): void {
  log.info("[desktop daemon]", message, {
    pid: process.pid,
    ...details,
  });
}

function statusFromDaemonProbe(
  payload: Record<string, unknown>,
  home: string,
): DesktopDaemonStatus {
  const local = typeof payload.localDaemon === "string" ? payload.localDaemon : "stopped";
  const processAlive = local === "running" || local === "not_ready";
  let status: DesktopDaemonState = "stopped";
  if (local === "not_ready") status = "starting";
  if (local === "running") status = "running";
  return {
    serverId: typeof payload.serverId === "string" ? payload.serverId : "",
    status,
    listen: typeof payload.listen === "string" ? payload.listen : null,
    hostname:
      status === "running" && typeof payload.hostname === "string" ? payload.hostname : null,
    pid: processAlive && typeof payload.pid === "number" ? payload.pid : null,
    home,
    version: typeof payload.daemonVersion === "string" ? payload.daemonVersion : null,
    desktopManaged: payload.desktopManaged === true,
    startedAt: typeof payload.startedAt === "string" ? payload.startedAt : null,
    ownedByDesktop: Boolean(
      ownedLaunch &&
      ownedLaunch.home === home &&
      payload.pid === ownedLaunch.instance.pid &&
      payload.startedAt === ownedLaunch.instance.startedAt,
    ),
    error: null,
  };
}

function resolveDesktopAppVersion(): string {
  if (app.isPackaged) {
    return app.getVersion();
  }

  try {
    const packageJsonPath = path.join(__dirname, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
      version?: unknown;
    };
    if (typeof pkg.version === "string" && pkg.version.trim().length > 0) {
      return pkg.version.trim();
    }
  } catch {
    // Fall back to Electron's default version if the package metadata is unavailable.
  }

  return app.getVersion();
}

// ---------------------------------------------------------------------------
// Daemon lifecycle
// ---------------------------------------------------------------------------

export async function resolveDesktopDaemonStatus(): Promise<DesktopDaemonStatus> {
  const home = getPimiHome();

  try {
    // The app polls this while no local daemon runs. Answer that case in-process,
    // since launching the CLI once per poll keeps spawning processes while idle.
    if (!(await readDaemonInstance(home))) {
      return statusFromDaemonProbe({ localDaemon: "stopped" }, home);
    }

    const payload = (await runExternalCliJsonCommand([
      "daemon",
      "status",
      "--home",
      home,
      "--json",
    ])) as Record<string, unknown>;
    return statusFromDaemonProbe(payload, home);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logDesktopDaemonLifecycle("resolveStatus failed", { error: errorMessage });
    return {
      serverId: "",
      status: "errored",
      listen: null,
      hostname: null,
      pid: null,
      home,
      version: null,
      desktopManaged: false,
      ownedByDesktop: false,
      startedAt: null,
      error: errorMessage,
    };
  }
}

function normalizeVersion(version: string | null): string | null {
  const trimmed = version?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^v/i, "");
}

interface DaemonInstanceIdentity {
  pid: number | null;
  startedAt: string | null;
}

function isInstance(instance: DaemonInstance, identity: DaemonInstanceIdentity): boolean {
  return instance.pid === identity.pid && instance.startedAt === identity.startedAt;
}

function differsFromAppVersion(current: DesktopDaemonStatus): boolean {
  const appVersion = normalizeVersion(resolveDesktopAppVersion());
  const daemonVersion = normalizeVersion(current.version);
  return Boolean(appVersion && daemonVersion && appVersion !== daemonVersion);
}

type AgentActivity = { state: "idle" } | { state: "busy" } | { state: "unknown"; error: string };

// The statuses the daemon itself counts as an agent doing work (`isAgentBusy` in the server).
const BUSY_AGENT_STATUSES = new Set(["initializing", "running"]);
const AGENT_ACTIVITY_TIMEOUT_MS = 10_000;

function isBusyAgent(agent: unknown): boolean {
  if (typeof agent !== "object" || agent === null || !("status" in agent)) {
    throw new Error("Agent list entry has no status.");
  }
  if (typeof agent.status !== "string") throw new Error("Agent list entry has no status.");
  return BUSY_AGENT_STATUSES.has(agent.status);
}

/**
 * Whether the daemon in `home` has an agent mid-run, background agents included. An answer that
 * fails, times out or cannot be read is "unknown"; callers must not stop a daemon on it.
 */
async function readAgentActivity(home: string): Promise<AgentActivity> {
  let deadline: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(
      () => reject(new Error(`Agent list timed out after ${AGENT_ACTIVITY_TIMEOUT_MS}ms.`)),
      AGENT_ACTIVITY_TIMEOUT_MS,
    );
  });
  try {
    const agents = await Promise.race([
      runExternalCliJsonCommand([
        "agent",
        "ls",
        "--global",
        "--background",
        "--home",
        home,
        "--json",
      ]),
      timedOut,
    ]);
    if (!Array.isArray(agents)) throw new Error("Agent list output is not a list.");
    return { state: agents.some(isBusyAgent) ? "busy" : "idle" };
  } catch (error) {
    return { state: "unknown", error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(deadline);
  }
}

interface VersionRestartDecision {
  restart: boolean;
  agentActivity: AgentActivity["state"] | null;
  agentActivityError: string | null;
}

/**
 * A daemon the user started is never replaced. The one this session launched always is. One an
 * earlier app session left running is replaced only while no agent is mid-run: it would otherwise
 * stay on the old version for good, but restarting it interrupts whatever its agents are doing,
 * so a busy one is left for the user to restart.
 */
async function decideVersionRestart(current: DesktopDaemonStatus): Promise<VersionRestartDecision> {
  const unchecked = { agentActivity: null, agentActivityError: null };
  if (!differsFromAppVersion(current)) return { restart: false, ...unchecked };
  if (current.ownedByDesktop) return { restart: true, ...unchecked };
  if (!current.desktopManaged) return { restart: false, ...unchecked };
  const activity = await readAgentActivity(current.home);
  return {
    restart: activity.state === "idle",
    agentActivity: activity.state,
    agentActivityError: activity.state === "unknown" ? activity.error : null,
  };
}

function assertBuiltInDaemonManagementEnabled(settings: DesktopSettings): void {
  if (!settings.daemon.manageBuiltInDaemon) {
    throw new Error("Built-in daemon management is disabled.");
  }
}

async function startDaemon(): Promise<DesktopDaemonStatus> {
  assertBuiltInDaemonManagementEnabled(await getDesktopSettingsStore().get());

  const current = await resolveDesktopDaemonStatus();
  logDesktopDaemonLifecycle("initial status check before start", {
    status: current.status,
    pid: current.pid,
    listen: current.listen,
    serverId: current.serverId || null,
    error: current.error,
    desktopManaged: current.desktopManaged,
  });
  if (current.status === "running" || current.status === "starting") {
    const decision = await decideVersionRestart(current);
    logDesktopDaemonLifecycle("daemon version check", {
      appVersion: normalizeVersion(resolveDesktopAppVersion()),
      daemonVersion: normalizeVersion(current.version),
      daemonPid: current.pid,
      ownedByDesktop: current.ownedByDesktop,
      desktopManaged: current.desktopManaged,
      ...decision,
    });
    if (!decision.restart) return current;
    if (current.ownedByDesktop) {
      await stopDesktopDaemon("version_mismatch");
    } else {
      // An agent that starts between the activity check and this stop is interrupted. The stop
      // re-reads the daemon's identity, not its activity, so that window stays open.
      await stopDaemonFromEarlierSession(current);
    }
  }

  const home = getPimiHome();
  const invocation = createNodeEntrypointInvocation({
    entrypoint: resolveDaemonRunnerEntrypoint(),
    argvMode: "node-script",
    args: [],
    baseEnv: process.env,
  });
  try {
    await startDaemonInstance({
      home,
      timeoutMs: 30_000,
      ...invocation,
      env: { ...invocation.env, PIMI_CLI: getBundledCliShimPath() },
      mode: "managed",
      desktopManaged: true,
      onAcquired: (instance) => {
        ownedLaunch = { home, instance };
      },
    });
  } catch (error) {
    if (!(error instanceof DaemonInstanceError && error.code === "DAEMON_NOT_READY")) throw error;
  }
  return resolveDesktopDaemonStatus();
}

export async function stopDesktopDaemon(
  reason: DesktopDaemonStopReason = DEFAULT_DESKTOP_DAEMON_STOP_REASON,
  confirmedInstance?: { pid: number; startedAt: string },
): Promise<DesktopDaemonStatus> {
  const home = getPimiHome();
  const instance = await readDaemonInstance(home);
  const owned = Boolean(
    instance &&
    ownedLaunch &&
    ownedLaunch.home === home &&
    isSameDaemonInstance(instance, ownedLaunch.instance),
  );
  // The reasons a user confirms against a named instance. A confirmed version restart is still
  // their decision; its reason only decides that terminals survive it.
  const explicit =
    (reason === "manual_ipc" || reason === "version_mismatch") &&
    confirmedInstance &&
    instance &&
    isInstance(instance, confirmedInstance);
  if (confirmedInstance && !explicit)
    throw new Error(
      "Daemon changed since confirmation; inspect its current home and PID before stopping it.",
    );
  if (!instance || (!owned && !explicit)) return resolveDesktopDaemonStatus();
  await stopSupervisor({ home, instance, reason, owned });
  if (owned) ownedLaunch = null;
  return resolveDesktopDaemonStatus();
}

/**
 * Stops the desktop-managed daemon an earlier app session left running, so the bundled version
 * replaces it. Only the instance the version check probed is stopped; whatever took its place
 * since then is attached to as it is.
 */
async function stopDaemonFromEarlierSession(probed: DesktopDaemonStatus): Promise<void> {
  const home = getPimiHome();
  const instance = await readDaemonInstance(home);
  if (!instance?.desktopManaged || !isInstance(instance, probed)) {
    logDesktopDaemonLifecycle("daemon changed since version check, attaching", {
      probedPid: probed.pid,
      daemonPid: instance?.pid ?? null,
      desktopManaged: instance?.desktopManaged === true,
    });
    return;
  }
  await stopSupervisor({ home, instance, reason: "version_mismatch", owned: false });
}

interface StopSupervisorInput {
  home: string;
  instance: DaemonInstance;
  reason: DesktopDaemonStopReason;
  owned: boolean;
}

async function stopSupervisor(input: StopSupervisorInput): Promise<void> {
  const keepTerminals = keepsTerminalsOnStop(input.reason, process.platform);
  logDesktopDaemonLifecycle("stopping captured supervisor", {
    reason: input.reason,
    pid: input.instance.pid,
    owned: input.owned,
    keepTerminals,
  });
  await stopCapturedDaemon({
    home: input.home,
    instance: input.instance,
    reason: input.reason,
    keepTerminals,
  });
}

export interface StopCapturedDaemonInput {
  home: string;
  instance: DaemonInstance;
  reason: DesktopDaemonStopReason;
  keepTerminals: boolean;
  stopInstance?: typeof stopDaemonInstance;
  runCliJson?: typeof runExternalCliJsonCommand;
}

/** Stops the supervisor desktop captured, keeping its terminals when asked. */
export async function stopCapturedDaemon(input: StopCapturedDaemonInput): Promise<void> {
  const stopInstance = input.stopInstance ?? stopDaemonInstance;
  const runCliJson = input.runCliJson ?? runExternalCliJsonCommand;
  await stopInstance(input.home, {
    instance: input.instance,
    timeoutMs: 15_000,
    keepTerminals: input.keepTerminals,
    requestShutdown: async (ready) => {
      await runCliJson([
        "daemon",
        "stop",
        "--host",
        ready.listen,
        ...(input.keepTerminals ? ["--keep-terminals"] : []),
        "--json",
      ]);
    },
  });
}

/**
 * Whether a desktop stop keeps the daemon's terminals running for the daemon that replaces it.
 * Only when one comes straight back (an app update, a version-mismatch restart), and never on
 * Windows: a surviving terminal worker runs Pimi.exe and would lock the install folder the
 * update replaces. Quit, Settings, host removal and manual stops close terminals.
 */
export function keepsTerminalsOnStop(
  reason: DesktopDaemonStopReason,
  platform: NodeJS.Platform,
): boolean {
  if (platform === "win32") return false;
  return reason === "app_update" || reason === "version_mismatch";
}

async function restartDaemon(): Promise<DesktopDaemonStatus> {
  await runExternalCliJsonCommand(["daemon", "restart", "--home", getPimiHome(), "--json"]);
  return resolveDesktopDaemonStatus();
}

function getDaemonLogs(): DesktopDaemonLogs {
  const logPath = logFilePath();
  return {
    logPath,
    contents: tailFile(logPath, 100),
  };
}

async function getCliDaemonStatus(): Promise<string> {
  return await runExternalCliTextCommand(["daemon", "status", "--home", getPimiHome()]);
}

async function getLocalDaemonVersion(): Promise<{ version: string | null; error: string | null }> {
  const status = await resolveDesktopDaemonStatus();
  if (status.status !== "running") {
    return { version: null, error: "Daemon is not running." };
  }
  return {
    version: status.version,
    error: status.version ? null : "Running daemon did not report a version.",
  };
}

async function resolveRequestedReleaseChannel(
  args: Record<string, unknown> | undefined,
): Promise<AppReleaseChannel> {
  return parseReleaseChannel(args) ?? (await getDesktopSettingsStore().get()).releaseChannel;
}

// ---------------------------------------------------------------------------
// IPC registration
// ---------------------------------------------------------------------------

export function createDaemonCommandHandlers(): Record<string, DesktopCommandHandler> {
  return {
    ...createDesktopSettingsCommandHandlers({ settingsStore: getDesktopSettingsStore() }),
    desktop_get_runtime_info: () => ({
      appVersion: resolveDesktopAppVersion(),
      runningUnderARM64Translation: isRunningUnderARM64Translation(),
    }),
    desktop_daemon_status: () => resolveDesktopDaemonStatus(),
    desktop_local_pairing: async (args) => {
      const input = PimiLocalPairingRequest.parse(args);
      const status = await resolveDesktopDaemonStatus();
      if (!status.listen || !status.desktopManaged || status.status !== "running") {
        throw new Error("Connect Pimi to its local desktop host to pair over Wi-Fi.");
      }
      const { host, port } = parseHostPort(status.listen);
      if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
        throw new Error("Wi-Fi pairing requires the desktop host to listen on loopback.");
      }
      const credential = readLocalCredentialForTarget(status.home, status.listen);
      if (!credential) throw new Error("Could not authenticate to the local Pimi host.");
      const response = await fetch(
        `http://${host === "::1" ? "[::1]" : host}:${port}${PIMI_LOCAL_PAIRING_ROUTE}`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
          body: JSON.stringify(input),
          redirect: "error",
          signal: AbortSignal.timeout(5000),
        },
      );
      if (response.status === 404)
        throw new Error("Update the local Pimi host to pair over Wi-Fi.");
      const payload = await response.json();
      if (!response.ok)
        throw new Error(
          typeof payload?.error === "string" ? payload.error : "Local pairing failed.",
        );
      return PimiLocalPairingStatus.parse(payload);
    },
    desktop_local_credential: async (args) => {
      const instance = await readDaemonInstance(getPimiHome());
      if (!instance?.desktopManaged || typeof args?.listen !== "string") return null;
      return readLocalCredentialForTarget(getPimiHome(), args.listen);
    },
    start_desktop_daemon: () => startDaemon(),
    stop_desktop_daemon: (args) =>
      stopDesktopDaemon(
        parseDesktopDaemonStopReason(args),
        typeof args?.pid === "number" && typeof args.startedAt === "string"
          ? { pid: args.pid, startedAt: args.startedAt }
          : undefined,
      ),
    restart_desktop_daemon: () => restartDaemon(),
    desktop_daemon_logs: () => getDaemonLogs(),
    desktop_sandbox_diagnostics: () =>
      describeSandbox({
        disabled: app.commandLine.hasSwitch("no-sandbox"),
      }),
    desktop_app_logs: () => getDesktopAppLogs(),
    desktop_update_diagnostics: () => getDesktopUpdaterDiagnostics(),
    desktop_get_system_idle_time: () => powerMonitor.getSystemIdleTime() * 1000,
    cli_daemon_status: () => getCliDaemonStatus(),
    write_attachment_base64: (args) => writeAttachmentBase64(args ?? {}),
    write_attachment_bytes: (args) => writeAttachmentBytes(args ?? {}),
    copy_attachment_file: (args) => copyAttachmentFileToManagedStorage(args ?? {}),
    read_file_base64: (args) => readManagedFileBase64(args ?? {}),
    delete_attachment_file: (args) => deleteManagedAttachmentFile(args ?? {}),
    garbage_collect_attachment_files: (args) => garbageCollectManagedAttachmentFiles(args ?? {}),
    open_local_daemon_transport: async (args) => await openLocalTransportSession(args),
    send_local_daemon_transport_message: async (args) => {
      await sendLocalTransportMessage(
        args as { sessionId: string; text?: string; binaryBase64?: string },
      );
    },
    close_local_daemon_transport: (args) => {
      const sessionId =
        typeof args === "object" && args !== null && "sessionId" in args
          ? (args as { sessionId: string }).sessionId
          : "";
      if (sessionId) closeLocalTransportSession(sessionId);
    },
    check_app_update: async (args) => {
      const currentVersion = resolveDesktopAppVersion();
      return checkForAppUpdate({
        currentVersion,
        releaseChannel: await resolveRequestedReleaseChannel(args),
        intent: parseAppUpdateCheckIntent(args),
      });
    },
    install_app_update: async (args) => {
      const currentVersion = resolveDesktopAppVersion();
      return downloadAndInstallUpdate(
        { currentVersion, releaseChannel: await resolveRequestedReleaseChannel(args) },
        async () => {
          await stopDesktopDaemon("app_update");
        },
      );
    },
    get_local_daemon_version: () => getLocalDaemonVersion(),
    install_cli: () => installCli(),
    uninstall_cli: () => uninstallCli(),
    get_cli_install_status: () => getCliInstallStatus(),
    read_legacy_skill_selection: () => readLegacySkillSelection(),
    delete_legacy_skill_selection: () => deleteLegacySkillSelection(),
  };
}

export function registerDaemonManager(onDaemonReady?: () => void): void {
  const handlers = createDaemonCommandHandlers();
  if (onDaemonReady) {
    for (const command of [
      "desktop_daemon_status",
      "start_desktop_daemon",
      "restart_desktop_daemon",
    ]) {
      const handleStatus = handlers[command];
      handlers[command] = async (args) => {
        const status = (await handleStatus(args)) as DesktopDaemonStatus;
        if (status.status === "running") onDaemonReady();
        return status;
      };
    }
  }

  ipcMain.handle("pimi:invoke", async (_event, command: string, args?: Record<string, unknown>) => {
    const handler = handlers[command];
    if (!handler) {
      throw new Error(`Unknown desktop command: ${command}`);
    }
    return await handler(args);
  });
}
