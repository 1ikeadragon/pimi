import { protectConsoleStreams } from "./diagnostics/console-streams.js";
protectConsoleStreams();

process.emitWarning = (() => {}) as typeof process.emitWarning;

import log from "electron-log/main";
log.transports.console.level = "info";
log.initialize({ spyRendererConsole: true });

import { inheritLoginShellEnv } from "./login-shell-env.js";
import {
  flushDesktopNetworkLog,
  getDesktopNetworkActivity,
  getDesktopNetworkLogDirectory,
  installDesktopNodeNetworkMonitor,
  observeSessionNetwork,
  startDesktopNetworkLog,
} from "./diagnostics/network-activity.js";
import { NETWORK_PURPOSE } from "@pimi/protocol/network-activity";
installDesktopNodeNetworkMonitor();

import {
  PimiOpenTaskDestination,
  PimiRecapPeriod,
  PimiReportLinkError,
  PimiReviewListDestination,
  PimiReviewPrDestination,
  PimiVoiceBubbleState,
  PimiVoiceCommandInput,
} from "@pimi/protocol/pimi-task";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  getPimiReviewSummary,
  hidePimiWorkspace,
  initializePimiWorkspace,
  pimiAppearanceArgument,
  reportPimiLinkError,
  setPimiAppearance,
  showPimiWindow,
  updatePimiContentBounds,
  updatePimiVoiceBubble,
  type PimiContentBounds,
  type PimiDestination,
} from "./window/pimi-window.js";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { execFile, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import {
  app,
  autoUpdater as electronAutoUpdater,
  BrowserWindow,
  ClipboardItem,
  clipboard,
  Menu,
  ipcMain,
  nativeImage,
  net,
  protocol,
  screen,
  session,
  shell,
  webContents,
} from "electron";
import { registerDaemonManager } from "./daemon/daemon-manager.js";
import { parsePassthroughCliArgsFromArgv, runPassthroughCli } from "./daemon/cli/passthrough.js";
import { closeAllTransportSessions } from "./daemon/local-transport.js";
import {
  applyDesktopWindowChromeMode,
  registerWindowManager,
  getMainWindowChromeOptions,
  getWindowBackgroundColor,
  resolveSystemWindowTheme,
  resolveWindowBounds,
  setupWindowResizeEvents,
  setupWindowStatePersistence,
  setupDefaultContextMenu,
  buildStandardContextMenuItems,
} from "./window/window-manager.js";
import { setupDarwinCompositorWatchdog } from "./window/compositor-watchdog/index.js";
import { showWindowWhenReady } from "./window/show-when-ready.js";
import { resolveDesktopWindowChromeMode, windowChromeModeArgument } from "./window/chrome.js";
import { registerDialogHandlers } from "./features/dialogs.js";
import {
  registerNotificationHandlers,
  ensureNotificationCenterRegistration,
  sendDesktopNotification,
} from "./features/notifications.js";
import { createExternalUrlOpener } from "./features/opener.js";
import { createBrowserCaptureService } from "./features/browser-capture.js";
import { registerEditorTargetHandlers } from "./features/editor-targets/ipc.js";
import { PIMI_EDITOR_TARGETS } from "./features/editor-targets/registry.js";
import { resolveAppIconPath } from "./features/stamped-icon.js";
import { setupApplicationMenu } from "./features/menu.js";
import {
  BROWSER_NEW_TAB_REQUEST_EVENT,
  decideBrowserWindowOpenRequest,
  getPaseoBrowserIdForWebContents,
  getPaseoBrowserWebContentsForHostWindow,
  getPaseoBrowserWebviewRegistry,
  listRegisteredPaseoBrowserIds,
  isPaseoBrowserWebviewAttach,
  preparePaseoBrowserWebContents,
  PendingBrowserWindowOpenRequests,
  registerBrowserWebviewNavigationGuards,
  unregisterPaseoBrowserFromHost,
  registerAttachedPaseoBrowser,
  getAttackNavigationPolicy,
  isAttackNavigationRefused,
  reportAttackNavigationRefused,
  setAttackNavigationPolicy,
  setWorkspaceActivePaseoBrowserId,
  unregisterPaseoBrowserHost,
} from "./features/browser-webviews/index.js";
import {
  clearPaseoBrowserProfile,
  getLegacyPaseoBrowserProfileSession,
  PASEO_BROWSER_PROFILE_PARTITION,
  getPaseoBrowserProfileSession,
  getPaseoBrowserProfileSessions,
  listPaseoBrowserProfileGuests,
  readLegacyPaseoBrowserIds,
} from "./features/browser-profile.js";
import { parseOpenProjectPathFromArgv } from "./open-project-routing.js";
import {
  createDesktopWindowOwner,
  type DesktopWindowOwner,
  type OwnedDesktopWindow,
} from "./window/desktop-window-owner.js";
import { getDesktopSettingsStore } from "./settings/desktop-settings-electron.js";
import { clampWindowStateToWorkAreas, createWindowStateStore } from "./settings/window-state.js";
import {
  isDesktopManagedDaemonRunningSync,
  stopDesktopDaemonViaCli,
} from "./daemon/daemon-manager.js";
import {
  createQuitLifecycle,
  registerExternalQuitSignals,
  stopDesktopManagedDaemonOnQuitIfNeeded,
} from "./daemon/quit-lifecycle.js";
import { runDesktopStartup } from "./desktop-startup.js";
import { registerBrowserAutomationIpc } from "./features/browser-automation/ipc.js";
import { BrowserKeyboard } from "./features/browser-keyboard/index.js";
import { installAppUpdateOnQuit } from "./features/auto-updater.js";
import {
  buildAgentDeepLinkRoute,
  parseAgentDeepLink,
  type AgentDeepLinkTarget,
} from "@pimi/protocol/agent-deep-link";
import { AgentNavigationInbox, parseAgentDeepLinkFromArgv } from "./agent-navigation.js";
import {
  PimiMemoryDestination,
  PimiNewTaskDestination,
  PimiSimpleDestinationView,
  PimiSpacesDestination,
  PimiTaskProposal,
} from "@pimi/protocol/pimi-task";
import { getForgeDefinition } from "@pimi/protocol/forge-manifest";

const DEV_SERVER_URL = process.env.EXPO_DEV_URL ?? "http://localhost:8081";
// Private Chromium origin retained for existing localStorage and IndexedDB.
// External agent links use the pimi protocol registered by the installer.
const APP_SCHEME = "paseo";
const CONSOLE_URL = app.isPackaged ? `${APP_SCHEME}://app/` : new URL(DEV_SERVER_URL).href;

function isConsoleUrl(value: string): boolean {
  const url = URL.parse(value);
  const consoleUrl = new URL(CONSOLE_URL);
  return Boolean(
    url &&
    url.protocol === consoleUrl.protocol &&
    url.host === consoleUrl.host &&
    !url.username &&
    !url.password,
  );
}

function setupPimiSessionPermissions(): void {
  const consoleSession = session.defaultSession;
  consoleSession.setPermissionCheckHandler((contents, permission, origin, details) => {
    if (
      !details.isMainFrame ||
      !isConsoleUrl(details.requestingUrl || origin || contents?.getURL() || "")
    )
      return false;
    return (
      permission === "clipboard-sanitized-write" ||
      (permission === "media" && details.mediaType !== "video")
    );
  });
  consoleSession.setPermissionRequestHandler((_contents, permission, reply, details) => {
    const trusted = details.isMainFrame && isConsoleUrl(details.requestingUrl);
    reply(
      trusted &&
        (permission === "clipboard-sanitized-write" ||
          (permission === "media" &&
            "mediaTypes" in details &&
            details.mediaTypes?.length === 1 &&
            details.mediaTypes[0] === "audio")),
    );
  });
  const browserSession = session.fromPartition(PASEO_BROWSER_PROFILE_PARTITION);
  observeSessionNetwork(consoleSession, { source: "app" });
  observeSessionNetwork(browserSession, { source: "browser", purpose: NETWORK_PURPOSE.browser });
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
  browserSession.setDevicePermissionHandler(() => false);
  consoleSession.setDevicePermissionHandler(() => false);
}
const PASEO_DEBUG = process.env.PASEO_DEBUG === "1";
const DISABLE_SINGLE_INSTANCE_LOCK = process.env.PASEO_DISABLE_SINGLE_INSTANCE_LOCK === "1";
const APP_NAME = process.env.PASEO_TEST_APP_NAME?.trim() || "Pimi";
const DESKTOP_WINDOW_CHROME_MODE = resolveDesktopWindowChromeMode({
  platform: process.platform,
  override: process.env.PASEO_DESKTOP_WINDOW_CONTROLS,
  isPackaged: app.isPackaged,
});
const UPDATE_QUIT_DEADLINE_MS = 5_000;
const pendingBrowserWindowOpenRequests = new PendingBrowserWindowOpenRequests();
const agentNavigationInbox = new AgentNavigationInbox();

// A second-instance launch can arrive before the packaged protocol handler,
// IPC handlers, and first window exist. Wait for full bootstrap, not just
// app.whenReady(), before delivering navigation to the renderer.
let resolveBootstrapComplete: () => void;
const bootstrapComplete = new Promise<void>((resolve) => {
  resolveBootstrapComplete = resolve;
});
let bootstrapIsComplete = false;

app.setName(APP_NAME);
log.info("[desktop] app startup", {
  version: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
  isPackaged: app.isPackaged,
});

interface AttachedBrowserInput {
  browserId: string;
  workspaceId: string;
  webContentsId: number;
}

function readAttachedBrowserInput(input: unknown): AttachedBrowserInput | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const record = input as Record<string, unknown>;
  if (typeof record.browserId !== "string" || record.browserId.trim().length === 0) {
    return null;
  }
  if (typeof record.workspaceId !== "string" || record.workspaceId.trim().length === 0) {
    return null;
  }
  if (
    typeof record.webContentsId !== "number" ||
    !Number.isInteger(record.webContentsId) ||
    record.webContentsId <= 0
  ) {
    return null;
  }
  return {
    browserId: record.browserId.trim(),
    workspaceId: record.workspaceId.trim(),
    webContentsId: record.webContentsId,
  };
}

function readActiveBrowserInput(
  input: unknown,
): { workspaceId: string; browserId: string | null } | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const record = input as Record<string, unknown>;
  if (typeof record.workspaceId !== "string" || record.workspaceId.trim().length === 0) {
    return null;
  }
  const browserId = typeof record.browserId === "string" ? record.browserId.trim() : null;
  return {
    workspaceId: record.workspaceId.trim(),
    browserId: browserId || null,
  };
}

const browserKeyboard = new BrowserKeyboard(getPaseoBrowserWebviewRegistry());
browserKeyboard.registerIpc();

function showBrowserWebviewContextMenu(
  win: BrowserWindow,
  contents: Electron.WebContents,
  params: Electron.ContextMenuParams,
): void {
  const menu = Menu.buildFromTemplate([
    ...buildStandardContextMenuItems(contents, params),
    ...(app.isPackaged
      ? []
      : [
          { type: "separator" as const },
          {
            label: "Inspect Element",
            click: () => {
              log.info("[browser-devtools] inspect-element.request", {
                webContentsId: contents.id,
                browserId: getPaseoBrowserIdForWebContents(contents),
                x: params.x,
                y: params.y,
                isDevToolsOpened: contents.isDevToolsOpened(),
              });
              contents.openDevTools({ mode: "detach" });
              contents.inspectElement(params.x, params.y);
              log.info("[browser-devtools] inspect-element.done", {
                webContentsId: contents.id,
                isDevToolsOpened: contents.isDevToolsOpened(),
              });
            },
          },
        ]),
  ]);
  menu.popup({ window: win });
}

function getBrowserPopupWindowOptions(
  mainWindow: BrowserWindow,
): Electron.BrowserWindowConstructorOptions {
  return {
    parent: mainWindow,
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      partition: PASEO_BROWSER_PROFILE_PARTITION,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
    },
  };
}

function installBrowserWindowOpenHandler(input: {
  contents: Electron.WebContents;
  sourceContents: Electron.WebContents;
  mainWindow: BrowserWindow;
}): void {
  const { contents, sourceContents, mainWindow } = input;

  contents.setWindowOpenHandler(({ url, disposition, frameName, features, postBody }) => {
    const decision = decideBrowserWindowOpenRequest({
      url,
      disposition,
      frameName,
      features,
      hasPostBody: postBody !== undefined && postBody !== null,
    });

    if (decision.kind === "deny") {
      return { action: "deny" };
    }
    // An Attack run's tabs open nothing outside their hosts: no popup windows, no new tabs to
    // other hosts. The renderer would otherwise open an unconfined tab for them.
    const attackSourceId = getPaseoBrowserIdForWebContents(sourceContents);
    const attackPolicy = attackSourceId ? getAttackNavigationPolicy(attackSourceId) : null;
    if (attackSourceId && attackPolicy) {
      if (decision.kind === "popup" || isAttackNavigationRefused(attackSourceId, url)) {
        reportAttackNavigationRefused(mainWindow.webContents, {
          runId: attackPolicy.runId,
          browserId: attackSourceId,
          url,
        });
        return { action: "deny" };
      }
    }
    if (decision.kind === "popup") {
      return {
        action: "allow",
        overrideBrowserWindowOptions: getBrowserPopupWindowOptions(mainWindow),
      };
    }

    const sourceBrowserId = getPaseoBrowserIdForWebContents(sourceContents);
    if (sourceBrowserId) {
      mainWindow.webContents.send(BROWSER_NEW_TAB_REQUEST_EVENT, {
        sourceBrowserId,
        url: decision.url,
      });
    } else {
      pendingBrowserWindowOpenRequests.add(sourceContents.id, decision.url);
    }
    return { action: "deny" };
  });

  contents.on("did-create-window", (popupWindow) => {
    const popupContents = popupWindow.webContents;
    registerBrowserWebviewNavigationGuards(popupContents);
    popupContents.on("context-menu", (_event, params) => {
      showBrowserWebviewContextMenu(popupWindow, popupContents, params);
    });
    installBrowserWindowOpenHandler({
      contents: popupContents,
      sourceContents,
      mainWindow,
    });
  });
}

// In dev mode, detect git worktrees and isolate each instance so multiple
// Electron windows can run side-by-side (separate userData = separate lock).
let devWorktreeName: string | null = null;
const forcedUserDataDir = process.env.PASEO_ELECTRON_USER_DATA_DIR?.trim();
if (forcedUserDataDir) {
  app.setPath("userData", forcedUserDataDir);
  log.info("[dev-user-data] forced userData dir:", forcedUserDataDir);
} else if (!app.isPackaged) {
  try {
    const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
      timeout: 3000,
      windowsHide: true,
    }).trim();
    devWorktreeName = path.basename(topLevel);
    // Main checkout (e.g. "Pimi") gets default userData — only worktrees diverge.
    const commonDir = path.resolve(
      topLevel,
      execFileSync("git", ["rev-parse", "--git-common-dir"], {
        cwd: topLevel,
        encoding: "utf-8",
        timeout: 3000,
        windowsHide: true,
      }).trim(),
    );
    const isWorktree = path.resolve(topLevel, ".git") !== commonDir;
    if (isWorktree) {
      app.setPath("userData", path.join(app.getPath("appData"), `Pimi-${devWorktreeName}`));
      log.info("[worktree] isolated userData for worktree:", devWorktreeName);
    } else {
      devWorktreeName = null;
    }
  } catch {
    devWorktreeName = null;
  }
}

// Allow users to pass Chromium flags via PASEO_ELECTRON_FLAGS for debugging
// rendering issues (e.g. "--disable-gpu --ozone-platform=x11").
// Must run before app.whenReady().
const electronFlags = process.env.PASEO_ELECTRON_FLAGS?.trim();
if (electronFlags) {
  for (const token of electronFlags.split(/\s+/)) {
    const [key, ...rest] = token.replace(/^--/, "").split("=");
    app.commandLine.appendSwitch(key, rest.join("=") || undefined);
  }
  log.info("[electron-flags]", electronFlags);
}

let pendingOpenProjectPath = parseOpenProjectPathFromArgv({
  argv: process.argv,
  isDefaultApp: process.defaultApp,
});
let pendingAgentNavigation = parseAgentDeepLinkFromArgv(process.argv);

// Each window pulls its own pending open-project path on mount, keyed by
// webContents id, so deep-linked windows (second-instance launches, the
// in-app "Open in new window" action) land on the right project without
// racing a global.
let desktopWindowOwner: DesktopWindowOwner<AgentDeepLinkTarget>;

if (PASEO_DEBUG) {
  log.info("[open-project] argv:", process.argv);
  log.info("[open-project] isDefaultApp:", process.defaultApp);
  log.info("[open-project] pendingOpenProjectPath:", pendingOpenProjectPath);
}

// The renderer pulls the pending path on mount via IPC — this avoids
// a race where the push event arrives before React registers its listener.
ipcMain.handle("paseo:get-pending-open-project", (event) => {
  const webContentsId = event.sender.id;
  const result = desktopWindowOwner.takePendingProject(webContentsId);
  log.info("[open-project] renderer requested pending path:", {
    webContentsId,
    pendingPath: result,
  });
  return result;
});

ipcMain.handle("paseo:agent-navigation:ready", (event) => {
  return agentNavigationInbox.windowReady(event.sender.id);
});

ipcMain.handle("paseo:browser:register-attached", (event, rawInput: unknown) => {
  const input = readAttachedBrowserInput(rawInput);
  if (!input) {
    throw new Error("Invalid attached browser registration");
  }
  const registered = registerAttachedPaseoBrowser({
    ...input,
    sender: event.sender,
    profileSession: getPaseoBrowserProfileSession(session),
    findWebContents: (webContentsId) => webContents.fromId(webContentsId) ?? null,
  });
  if (!registered) {
    throw new Error("Attached browser registration was rejected");
  }
  const guest = webContents.fromId(input.webContentsId);
  if (!guest) {
    throw new Error("Attached browser guest disappeared after registration");
  }
  browserKeyboard.attach({ contents: guest, hostContents: event.sender });
  log.info("[browser-webview] registered", {
    browserId: input.browserId,
    webContentsId: input.webContentsId,
    registeredBrowserIds: listRegisteredPaseoBrowserIds(),
  });
  for (const url of pendingBrowserWindowOpenRequests.take(input.webContentsId)) {
    event.sender.send(BROWSER_NEW_TAB_REQUEST_EVENT, {
      sourceBrowserId: input.browserId,
      url,
    });
  }
});

ipcMain.handle("paseo:browser:unregister-workspace-browser", async (event, browserId: unknown) => {
  if (typeof browserId === "string" && browserId.trim().length > 0) {
    const normalizedBrowserId = browserId.trim();
    const hasOtherHost = getPaseoBrowserWebviewRegistry().hasBrowserInOtherHostWindow(
      event.sender.id,
      normalizedBrowserId,
    );
    unregisterPaseoBrowserFromHost(event.sender.id, normalizedBrowserId);
    // COMPAT(browserProfile): added in v0.1.108; remove after 2027-01-15.
    const legacyProfile = hasOtherHost
      ? null
      : getLegacyPaseoBrowserProfileSession(session, normalizedBrowserId);
    if (legacyProfile) {
      try {
        await clearPaseoBrowserProfile({
          profileSessions: [legacyProfile],
          listGuests: () => [],
          logReloadError: () => {},
        });
      } catch (error) {
        log.warn("[browser-profile] failed to clear legacy tab profile", {
          browserId: normalizedBrowserId,
          error,
        });
      }
    }
  }
});

ipcMain.handle("paseo:browser:set-attack-policy", (_event, rawInput: unknown) => {
  if (typeof rawInput !== "object" || rawInput === null || Array.isArray(rawInput)) return;
  const input = rawInput as Record<string, unknown>;
  const hosts = Array.isArray(input.allowedHosts)
    ? input.allowedHosts.filter((host): host is string => typeof host === "string" && host !== "")
    : [];
  if (
    typeof input.browserId !== "string" ||
    input.browserId.trim() === "" ||
    typeof input.runId !== "string" ||
    input.runId === "" ||
    hosts.length === 0
  ) {
    return;
  }
  setAttackNavigationPolicy(input.browserId.trim(), { runId: input.runId, allowedHosts: hosts });
});

ipcMain.handle("paseo:browser:set-workspace-active-browser", (event, rawInput: unknown) => {
  const input = readActiveBrowserInput(rawInput);
  if (input) {
    setWorkspaceActivePaseoBrowserId({
      ...input,
      hostWebContentsId: event.sender.id,
    });
  }
});

ipcMain.handle("paseo:browser:focus", (event, browserId: unknown): boolean => {
  if (typeof browserId !== "string" || browserId.trim().length === 0) {
    return false;
  }
  const contents = getPaseoBrowserWebContentsForHostWindow(browserId, event.sender.id);
  if (!contents) {
    return false;
  }
  contents.focus();
  return true;
});

ipcMain.handle("paseo:browser:open-devtools", (event, browserId: unknown) => {
  if (typeof browserId !== "string" || browserId.trim().length === 0) {
    const result = {
      ok: false,
      reason: "invalid-browser-id",
      browserId,
      registeredBrowserIds: listRegisteredPaseoBrowserIds(),
    };
    log.warn("[browser-devtools] open-devtools.invalid", result);
    return result;
  }
  const contents = getPaseoBrowserWebContentsForHostWindow(browserId, event.sender.id);
  if (!contents) {
    const result = {
      ok: false,
      reason: "browser-webcontents-not-found",
      browserId,
      registeredBrowserIds: listRegisteredPaseoBrowserIds(),
    };
    log.warn("[browser-devtools] open-devtools.not-found", result);
    return result;
  }
  log.info("[browser-devtools] open-devtools.request", {
    browserId,
    webContentsId: contents.id,
    isDestroyed: contents.isDestroyed(),
    isDevToolsOpened: contents.isDevToolsOpened(),
    registeredBrowserIds: listRegisteredPaseoBrowserIds(),
  });
  contents.openDevTools({ mode: "detach" });
  const result = {
    ok: true,
    reason: "opened",
    browserId,
    webContentsId: contents.id,
    isDevToolsOpened: contents.isDevToolsOpened(),
  };
  log.info("[browser-devtools] open-devtools.done", result);
  return result;
});

ipcMain.handle("paseo:browser:clear-profile", async (_event, rawLegacyBrowserIds: unknown) => {
  const profileSessions = getPaseoBrowserProfileSessions(
    session,
    readLegacyPaseoBrowserIds(rawLegacyBrowserIds),
  );
  const profileSession = profileSessions[0];
  await clearPaseoBrowserProfile({
    profileSessions,
    listGuests: () =>
      listPaseoBrowserProfileGuests({
        profileSession,
        webContents: webContents.getAllWebContents(),
      }),
    logReloadError: (webContentsId, error) => {
      log.warn("[browser-profile] failed to reload guest", {
        webContentsId,
        error,
      });
    },
  });
});

const browserCapture = createBrowserCaptureService<Electron.NativeImage>({
  findGuest: getPaseoBrowserWebContentsForHostWindow,
  decodeImage: (dataUrl) => nativeImage.createFromDataURL(dataUrl),
  clipboard: {
    write: async ({ text, image }) => {
      const items: Record<string, string | Blob> = {};
      if (text) items["text/plain"] = text;
      if (image) {
        const png = image.toPNG();
        const bytes = new Uint8Array(png.byteLength);
        bytes.set(png);
        items["image/png"] = new Blob([bytes], { type: "image/png" });
      }
      await clipboard.write([new ClipboardItem(items)]);
    },
  },
  warn: (event, details) => log.warn(`[browser-capture] ${event}`, details),
});

ipcMain.handle("paseo:browser:capture-element", (event, browserId: unknown, rect: unknown) =>
  browserCapture.capture({
    browserId,
    hostWebContentsId: event.sender.id,
    rect,
  }),
);

ipcMain.handle("paseo:browser:copy-element", (_event, payload: unknown) =>
  browserCapture.copy(payload),
);

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
  },
]);

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------

function getPreloadPath(): string {
  return path.join(__dirname, "preload.js");
}

function getBrowserKeyboardPreloadPath(): string {
  return path.join(__dirname, "features", "browser-keyboard", "guest-preload.js");
}

function getAppDistDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "app-dist");
  }

  return path.resolve(__dirname, "../../app/dist");
}

function getWindowIconCandidates(): string[] {
  return [
    app.isPackaged
      ? path.join(process.resourcesPath, "pimi-icon.png")
      : path.resolve(__dirname, "../assets/pimi-icon.png"),
  ];
}

function getWindowIconPath(): string | null {
  const candidates = getWindowIconCandidates();
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function getDevBuildLabel(): string | null {
  if (app.isPackaged) {
    return null;
  }
  return process.env.EXPO_PUBLIC_PASEO_DEV_BUILD_LABEL?.trim() || null;
}

let cachedEffectiveIconPath: string | null = null;

async function getEffectiveAppIconPath(): Promise<string | null> {
  if (cachedEffectiveIconPath !== null) {
    return cachedEffectiveIconPath;
  }
  const baseIconPath = getWindowIconPath();
  if (app.isPackaged || !baseIconPath) {
    cachedEffectiveIconPath = baseIconPath;
    return baseIconPath;
  }
  const devLabel = getDevBuildLabel();
  cachedEffectiveIconPath = await resolveAppIconPath({
    isPackaged: false,
    baseIconPath,
    devLabel,
    cacheDir: app.getPath("userData"),
  });
  return cachedEffectiveIconPath;
}

async function applyAppIcon(): Promise<void> {
  // Packaged apps keep the bundle icon and its macOS system appearance.
  if (app.isPackaged || process.platform !== "darwin") {
    return;
  }

  const iconPath = await getEffectiveAppIconPath();
  if (!iconPath) {
    return;
  }

  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    return;
  }

  app.dock?.setIcon(icon);
}

// Work areas with the primary display first, so window-state clamping treats
// it as the fallback. getAllDisplays() order is not guaranteed to lead with it.
function getWorkAreasPrimaryFirst(): Electron.Rectangle[] {
  const primary = screen.getPrimaryDisplay();
  const others = screen.getAllDisplays().filter((display) => display.id !== primary.id);
  return [primary, ...others].map((display) => display.workArea);
}

function findConsoleWindow(preferred?: BrowserWindow): BrowserWindow | undefined {
  if (preferred && !preferred.isDestroyed()) return preferred;
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
}

async function resolvePimiConsoleWindow(preferred?: BrowserWindow): Promise<BrowserWindow> {
  let win = findConsoleWindow(preferred);
  if (!win) {
    await desktopWindowOwner.openPrimary();
    win = findConsoleWindow();
  }
  if (!win) throw new Error("Pimi could not open the Agent Console.");
  return win;
}

function openPimiSettings(): void {
  const route = "/settings/appearance";
  const win = findConsoleWindow();
  if (win) {
    hidePimiWorkspace(win);
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send("pimi:settings:open");
  } else {
    void desktopWindowOwner.openPrimary({ initialRoute: route }).catch((error) => {
      log.error("[pimi] failed to open settings", error);
    });
  }
}

function openPimi(destination?: PimiDestination, preferred?: BrowserWindow): void {
  void showPimiWindow(
    {
      runtimeDir: path.join(app.getAppPath(), "dist"),
      dictationUrl: app.isPackaged
        ? `${APP_SCHEME}://app/pimi-dictation`
        : new URL("/pimi-dictation", DEV_SERVER_URL).toString(),
      preload: getPreloadPath(),
      workspacePreload: path.join(path.dirname(getPreloadPath()), "pimi-workspace-preload.js"),
      resolveConsoleWindow: resolvePimiConsoleWindow,
      openAgentChat: (target) => {
        void desktopWindowOwner
          .openOrFocusAgent(target)
          .catch((error) => log.error("[pimi] failed to open agent chat", error));
      },
    },
    destination,
    preferred,
  ).catch((error) => log.error("[pimi] failed to open workspace", error));
}

function registerPimiWorkspaceNavigation(): void {
  function isConsoleFrame(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
    const frame = event.senderFrame;
    return Boolean(frame && frame === event.sender.mainFrame && isConsoleUrl(frame.url));
  }
  ipcMain.handle("pimi:appearance:set", async (event, mode: unknown) => {
    if (!isConsoleFrame(event)) throw new Error("Open Pimi Settings to change appearance.");
    await setPimiAppearance(mode);
  });
  ipcMain.handle("pimi:network-activity:list", (event, value: unknown) => {
    if (!isConsoleFrame(event)) throw new Error("Open Pimi Settings to view network activity.");
    const input =
      typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    return getDesktopNetworkActivity({
      includeLocal: input.includeLocal === true,
      limit:
        typeof input.limit === "number" && Number.isInteger(input.limit) && input.limit > 0
          ? Math.min(input.limit, 1000)
          : 300,
    });
  });
  ipcMain.handle("pimi:network-activity:open-logs-folder", async (event) => {
    if (!isConsoleFrame(event)) throw new Error("Open Pimi Settings to open the logs folder.");
    const directory = getDesktopNetworkLogDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const failure = await shell.openPath(directory);
    if (failure) throw new Error(failure);
  });
  ipcMain.handle("pimi:labels:get", async (event) => {
    if (!isConsoleFrame(event)) throw new Error("Open Pimi to read linked labels.");
    const runtime = await initializePimiWorkspace(path.join(app.getAppPath(), "dist"));
    return runtime.getLinkedLabels();
  });
  ipcMain.handle("pimi:recap:get", async (event, value: unknown) => {
    if (!isConsoleFrame(event)) throw new Error("Open Pimi to read your recap.");
    const period = PimiRecapPeriod.parse(value);
    const runtime = await initializePimiWorkspace(path.join(app.getAppPath(), "dist"));
    return runtime.getRecap(period);
  });
  ipcMain.handle("pimi:voice:command", async (event, value: unknown) => {
    if (!isConsoleFrame(event)) throw new Error("Ask Pimi is only available in the app.");
    const input = PimiVoiceCommandInput.parse(value);
    const runtime = await initializePimiWorkspace(path.join(app.getAppPath(), "dist"));
    const { sender } = event;
    return runtime.runVoiceCommand(input, (status) => {
      if (!sender.isDestroyed()) sender.send("pimi:voice:status", status);
    });
  });
  ipcMain.handle("pimi:review:summary", (event, checkout: unknown) => {
    if (
      !isConsoleFrame(event) ||
      typeof checkout !== "string" ||
      checkout.length > 4096 ||
      !path.isAbsolute(checkout)
    ) {
      throw new Error("Choose a local checkout to review.");
    }
    return getPimiReviewSummary(path.join(app.getAppPath(), "dist"), checkout);
  });
  ipcMain.handle("pimi:forge:auth-status", (event, provider: unknown) => {
    if (!isConsoleFrame(event) || (provider !== "github" && provider !== "gitlab")) {
      throw new Error("Invalid Git provider status request.");
    }
    const forge = getForgeDefinition(provider);
    const cli = forge?.signIn?.cli;
    const hostname = forge?.cloudHosts?.[0];
    if (!cli || !hostname) return "unverified";
    return new Promise((resolve) => {
      execFile(
        cli,
        ["auth", "status", "--hostname", hostname],
        { cwd: homedir(), timeout: 10_000, windowsHide: true },
        (error) => {
          if (!error) resolve("connected");
          else resolve(error.code === "ENOENT" ? "cli-missing" : "unverified");
        },
      );
    });
  });
  ipcMain.on("pimi:workspace:report-link-error", (event, value: unknown) => {
    if (!isConsoleFrame(event)) return;
    const error = PimiReportLinkError.safeParse(value);
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (owner && error.success) reportPimiLinkError(owner, error.data);
  });
  ipcMain.on("pimi:workspace:dismiss", (event) => {
    if (!isConsoleFrame(event)) return;
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (owner) hidePimiWorkspace(owner);
  });
  ipcMain.on("pimi:voice:state", (event, value: unknown) => {
    if (!isConsoleFrame(event)) return;
    const state = PimiVoiceBubbleState.safeParse(value);
    if (!state.success) return;
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (owner) updatePimiVoiceBubble(owner, state.data);
  });
  ipcMain.on("pimi:workspace:content-bounds", (event, value: unknown) => {
    if (!isConsoleFrame(event) || !value || typeof value !== "object") return;
    const { x, y, width, height, sidebar } = value as PimiContentBounds;
    if (
      ![x, y, width, height].every(Number.isFinite) ||
      width <= 0 ||
      height <= 0 ||
      typeof sidebar !== "boolean"
    )
      return;
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (owner) updatePimiContentBounds(owner, { x, y, width, height, sidebar });
  });
  ipcMain.on("pimi:workspace:show", (event, destination: unknown) => {
    if (!isConsoleFrame(event) || !destination || typeof destination !== "object") return;
    const {
      view,
      path: checkout,
      proposal,
      serverId,
    } = destination as {
      view?: unknown;
      path?: unknown;
      proposal?: unknown;
      serverId?: unknown;
    };
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const simple = PimiSimpleDestinationView.safeParse(view);
    if (simple.success) return openPimi({ view: simple.data }, owner);
    const destinationSchema = {
      memory: PimiMemoryDestination,
      spaces: PimiSpacesDestination,
      task: PimiOpenTaskDestination,
      "new-task": PimiNewTaskDestination,
      "review-pr": PimiReviewPrDestination,
      "review-prs": PimiReviewListDestination,
    };
    for (const [name, schema] of Object.entries(destinationSchema)) {
      if (view !== name) continue;
      const result = schema.safeParse(destination);
      if (result.success) openPimi(result.data, owner);
      return;
    }
    if (view === "review" && typeof checkout === "string" && path.isAbsolute(checkout)) {
      if (serverId !== undefined && (typeof serverId !== "string" || !serverId.trim())) return;
      openPimi({ view, path: checkout, serverId }, owner);
    }
    if (view === "task-draft") {
      const result = PimiTaskProposal.safeParse(proposal);
      if (result.success) openPimi({ view, proposal: result.data }, owner);
    }
  });
}

async function createWindow(
  options: {
    initialRoute?: string | null;
    restoreWindowState?: boolean;
    onCreated?: (webContentsId: number) => void;
    onClosed?: (webContentsId: number) => void;
  } = {},
): Promise<BrowserWindow> {
  const iconPath = await getEffectiveAppIconPath();
  const systemTheme = resolveSystemWindowTheme();

  // Only the first window of a session restores and persists saved geometry.
  // Additional windows (⌘N, second-instance, "Open in new window") open at the
  // default size and let the OS cascade them, so they neither stack on top of
  // the restored window nor fight over the single window-state store.
  const restoreWindowState = options.restoreWindowState ?? false;
  const windowStateStore = restoreWindowState
    ? createWindowStateStore({ userDataPath: app.getPath("userData") })
    : null;
  const savedWindowState = windowStateStore ? await windowStateStore.load() : null;
  const restoredWindowState = savedWindowState
    ? clampWindowStateToWorkAreas(savedWindowState, getWorkAreasPrimaryFirst())
    : null;

  const title = devWorktreeName ? `${APP_NAME} (${devWorktreeName})` : APP_NAME;
  const mainWindow = new BrowserWindow({
    title,
    ...resolveWindowBounds(restoredWindowState),
    show: false,
    backgroundColor: getWindowBackgroundColor(systemTheme),
    ...(iconPath ? { icon: iconPath } : {}),
    ...getMainWindowChromeOptions({
      mode: DESKTOP_WINDOW_CHROME_MODE,
    }),
    webPreferences: {
      preload: getPreloadPath(),
      additionalArguments: [
        `--paseo-console-url=${CONSOLE_URL}`,
        windowChromeModeArgument(DESKTOP_WINDOW_CHROME_MODE),
        pimiAppearanceArgument(),
      ],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: process.platform === "darwin",
      webviewTag: true,
    },
  });
  applyDesktopWindowChromeMode({
    win: mainWindow,
    mode: DESKTOP_WINDOW_CHROME_MODE,
  });
  mainWindow.on("page-title-updated", (event) => event.preventDefault());

  const webContentsId = mainWindow.webContents.id;
  options.onCreated?.(webContentsId);
  mainWindow.webContents.on("did-start-navigation", (_event, _url, isSameDocument, isMainFrame) => {
    if (isMainFrame && !isSameDocument) {
      agentNavigationInbox.windowLoading(webContentsId);
    }
  });
  mainWindow.on("closed", () => {
    options.onClosed?.(webContentsId);
    agentNavigationInbox.removeWindow(webContentsId);
    unregisterPaseoBrowserHost(webContentsId);
    browserKeyboard.detachHost(webContentsId);
  });

  if (devWorktreeName) {
    app.dock?.setBadge(devWorktreeName);
  }

  if (restoredWindowState?.isMaximized) {
    mainWindow.maximize();
  }

  setupDarwinCompositorWatchdog(mainWindow);
  setupWindowResizeEvents(mainWindow);
  if (windowStateStore) {
    setupWindowStatePersistence(mainWindow, windowStateStore);
  }
  setupDefaultContextMenu(mainWindow);
  mainWindow.webContents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame) {
      if (!isConsoleUrl(event.url)) event.preventDefault();
      return;
    }
    const source = URL.parse(event.url);
    const isLocalDocument =
      source?.protocol === "data:" ||
      source?.protocol === "blob:" ||
      event.url === "about:srcdoc" ||
      event.url === "about:blank";
    // The console can supply a local preview. The preview cannot change its own document.
    if (!isLocalDocument || event.initiator !== mainWindow.webContents.mainFrame) {
      event.preventDefault();
    }
  });
  mainWindow.webContents.on("will-redirect", (event) => {
    if (!event.isMainFrame || !isConsoleUrl(event.url)) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    if (!isPaseoBrowserWebviewAttach(params)) {
      event.preventDefault();
      return;
    }
    webPreferences.nodeIntegration = false;
    // The sandboxed keyboard preload must run in every frame so focused iframes keep
    // the same page-first shortcut boundary. Node integration remains disabled.
    webPreferences.nodeIntegrationInSubFrames = true;
    webPreferences.nodeIntegrationInWorker = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.webviewTag = false;
    webPreferences.allowRunningInsecureContent = false;
    webPreferences.spellcheck = false;
    delete webPreferences.preload;
    delete params.preload;
    delete (webPreferences as { preloadURL?: string }).preloadURL;
    delete (params as { preloadURL?: string }).preloadURL;
    webPreferences.preload = getBrowserKeyboardPreloadPath();
  });
  mainWindow.webContents.on("did-attach-webview", (_event, contents) => {
    preparePaseoBrowserWebContents(contents);
    contents.once("destroyed", () => {
      pendingBrowserWindowOpenRequests.delete(contents.id);
    });
    installBrowserWindowOpenHandler({
      contents,
      sourceContents: contents,
      mainWindow,
    });
    contents.on("context-menu", (_contextMenuEvent, params) => {
      showBrowserWebviewContextMenu(mainWindow, contents, params);
    });
    registerBrowserWebviewNavigationGuards(contents);
  });

  showWindowWhenReady(mainWindow, {
    showOnLoad: process.platform === "linux",
  });

  if (!app.isPackaged) {
    const { loadReactDevTools } = await import("./features/react-devtools.js");
    await loadReactDevTools();
    const initialUrl = options.initialRoute
      ? new URL(options.initialRoute, `${DEV_SERVER_URL}/`).toString()
      : DEV_SERVER_URL;
    await mainWindow.loadURL(initialUrl);
    return mainWindow;
  }

  await mainWindow.loadURL(`${APP_SCHEME}://app${options.initialRoute ?? "/"}`);
  return mainWindow;
}

function ownedDesktopWindow(win: BrowserWindow): OwnedDesktopWindow<AgentDeepLinkTarget> {
  return {
    webContentsId: win.webContents.id,
    isDestroyed: () => win.isDestroyed(),
    isVisible: () => win.isVisible(),
    isMinimized: () => win.isMinimized(),
    restore: () => win.restore(),
    show: () => win.show(),
    focus: () => win.focus(),
    sendAgent: (target) => {
      hidePimiWorkspace(win);
      win.webContents.send("paseo:event:open-agent", target);
    },
  };
}

desktopWindowOwner = createDesktopWindowOwner<AgentDeepLinkTarget>({
  async create(input) {
    const win = await createWindow({
      initialRoute: input.initialRoute,
      restoreWindowState: input.restoreWindowState,
      onCreated: input.onCreated,
      onClosed: input.onClosed,
    });
    return ownedDesktopWindow(win);
  },
  windows: () => BrowserWindow.getAllWindows().map(ownedDesktopWindow),
  focusedWindow: () => {
    const win = BrowserWindow.getFocusedWindow();
    return win ? ownedDesktopWindow(win) : null;
  },
  agentRoute: buildAgentDeepLinkRoute,
  deliverAgent: (webContentsId, target) =>
    agentNavigationInbox.deliverOrQueue(webContentsId, target),
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

function receiveAgentDeepLink(input: string): void {
  const target = parseAgentDeepLink(input);
  if (!target) {
    return;
  }

  if (bootstrapIsComplete) {
    void desktopWindowOwner
      .openOrFocusAgent(target)
      .catch((error) => log.error("[window] failed to route agent link", error));
    return;
  }

  pendingAgentNavigation = target;
  void bootstrapComplete.then(() => {
    if (pendingAgentNavigation !== target) {
      return undefined;
    }
    pendingAgentNavigation = null;
    void desktopWindowOwner
      .openOrFocusAgent(target)
      .catch((error) => log.error("[window] failed to route queued agent link", error));
    return undefined;
  });
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  receiveAgentDeepLink(url);
});

function setupSingleInstanceLock(): boolean {
  if (DISABLE_SINGLE_INSTANCE_LOCK) {
    log.info("[single-instance] disabled by PASEO_DISABLE_SINGLE_INSTANCE_LOCK");
    return true;
  }

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return false;
  }

  app.on("second-instance", (_event, commandLine) => {
    const agentTarget = parseAgentDeepLinkFromArgv(commandLine);
    if (agentTarget) {
      void bootstrapComplete
        .then(() => desktopWindowOwner.openOrFocusAgent(agentTarget))
        .catch((error) => log.error("[window] failed to route second-instance agent link", error));
      return;
    }

    log.info("[open-project] second-instance commandLine:", commandLine);
    const openProjectPath = parseOpenProjectPathFromArgv({
      argv: commandLine,
      isDefaultApp: false,
    });
    log.info("[open-project] second-instance openProjectPath:", openProjectPath);
    // Relaunching the app (CLI `pimi [path]`, double-click, etc.) opens a new
    // window rather than focusing the existing one. Wait for bootstrap (not just
    // app.whenReady) so the protocol + IPC handlers exist before the window loads.
    void bootstrapComplete
      .then(() =>
        desktopWindowOwner.openAdditional({
          pendingProjectPath: openProjectPath,
        }),
      )
      .catch((error) => {
        log.error("[window] failed to create window from second-instance", error);
      });
  });

  return true;
}

async function runCliPassthroughIfRequested(): Promise<boolean> {
  const cliArgs = parsePassthroughCliArgsFromArgv(process.argv);
  if (!cliArgs) {
    return false;
  }

  try {
    const exitCode = await runPassthroughCli(cliArgs);
    app.exit(exitCode);
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    app.exit(1);
  }

  return true;
}

async function bootstrap(): Promise<void> {
  if (!setupSingleInstanceLock()) {
    return;
  }

  await app.whenReady();
  startDesktopNetworkLog();
  setupPimiSessionPermissions();

  const appDistDir = getAppDistDir();
  protocol.handle(APP_SCHEME, (request) => {
    const { host, username, password, pathname, search, hash } = new URL(request.url);
    if (host !== "app" || username || password) return new Response("Not found", { status: 404 });
    const decodedPath = decodeURIComponent(pathname);

    // Chromium can occasionally request the exported entrypoint directly.
    // Canonicalize it back to the route URL so Expo Router sees `/`, not `/index.html`.
    if (decodedPath.endsWith("/index.html")) {
      const normalizedPath = decodedPath.slice(0, -"/index.html".length) || "/";
      return Response.redirect(`${APP_SCHEME}://app${normalizedPath}${search}${hash}`, 307);
    }

    const filePath = path.join(appDistDir, decodedPath);
    const relativePath = path.relative(appDistDir, filePath);

    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      return new Response("Not found", { status: 404 });
    }

    // SPA fallback: serve index.html for routes without a file extension
    if (!relativePath || !path.extname(relativePath)) {
      return net.fetch(pathToFileURL(path.join(appDistDir, "index.html")).toString());
    }

    return net.fetch(pathToFileURL(filePath).toString());
  });

  await applyAppIcon();
  setupApplicationMenu({
    onOpenPimi: () => openPimi(),
    onOpenSettings: openPimiSettings,
    onNewWindow: () => {
      void desktopWindowOwner.openAdditional().catch((error) => {
        log.error("[window] failed to create window from menu", error);
      });
    },
  });
  ensureNotificationCenterRegistration();
  const observePimiWorkspaces = () => {
    void initializePimiWorkspace(path.join(app.getAppPath(), "dist"), async ({ id, title }) => {
      await sendDesktopNotification({
        title: "Task complete",
        body: title,
        onClick: () => openPimi({ view: "task", id }),
      });
    })
      .then((runtime) => runtime.observeWorkspaces())
      .catch((error) => log.debug("[pimi] workspace observation unavailable", error));
  };
  registerDaemonManager(observePimiWorkspaces);
  registerWindowManager({ mode: DESKTOP_WINDOW_CHROME_MODE });
  registerPimiWorkspaceNavigation();
  observePimiWorkspaces();
  registerDialogHandlers();
  registerNotificationHandlers();
  const openExternalUrl = createExternalUrlOpener({ open: shell.openExternal });
  ipcMain.handle("paseo:opener:openUrl", (_event, value: unknown) => openExternalUrl(value));
  registerEditorTargetHandlers({
    targets: PIMI_EDITOR_TARGETS,
  });
  registerBrowserAutomationIpc();

  // In-app "Open in new window": opens a window that lands on the given project
  // via the same open-project flow as a CLI launch (no move, no ownership).
  ipcMain.handle("paseo:window:openNew", async (_event, options?: unknown) => {
    const pendingPath =
      options && typeof options === "object" && "pendingOpenProjectPath" in options
        ? (options as { pendingOpenProjectPath?: unknown }).pendingOpenProjectPath
        : null;
    await desktopWindowOwner.openAdditional({
      pendingProjectPath: typeof pendingPath === "string" ? pendingPath : null,
    });
  });

  // The first window of the session restores and persists saved geometry.
  const initialAgentNavigation = pendingAgentNavigation;
  pendingAgentNavigation = null;
  await desktopWindowOwner.openPrimary({
    initialRoute: initialAgentNavigation ? buildAgentDeepLinkRoute(initialAgentNavigation) : null,
    pendingProjectPath: pendingOpenProjectPath,
  });
  pendingOpenProjectPath = null;

  // Protocol + IPC handlers and the first window now exist: release any
  // second-instance launches that arrived during cold start.
  bootstrapIsComplete = true;
  resolveBootstrapComplete();

  if (pendingAgentNavigation) {
    const target = pendingAgentNavigation;
    pendingAgentNavigation = null;
    await desktopWindowOwner.openOrFocusAgent(target);
  }

  app.on("activate", () => {
    void desktopWindowOwner.restoreWhenActivated().catch((error) => {
      console.error("Failed to restore a desktop window after activation", error);
    });
  });
}

void runDesktopStartup({
  hasPendingGuiLaunchRequest: Boolean(pendingOpenProjectPath || pendingAgentNavigation),
  runCliPassthroughIfRequested,
  inheritLoginShellEnv,
  bootstrapGui: bootstrap,
}).catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});

function showDaemonShutdownDialog(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("paseo:event:quitting", {});
  }
}

const quitLifecycle = createQuitLifecycle({
  app,
  closeTransportSessions: closeAllTransportSessions,
  stopDesktopManagedDaemonIfNeeded: () =>
    stopDesktopManagedDaemonOnQuitIfNeeded({
      settingsStore: getDesktopSettingsStore(),
      isDesktopManagedDaemonRunning: isDesktopManagedDaemonRunningSync,
      stopDaemon: () => stopDesktopDaemonViaCli("quit"),
      showShutdownFeedback: showDaemonShutdownDialog,
    }),
  installAppUpdateOnQuit: async (signal) => {
    const settings = await getDesktopSettingsStore().get();
    return installAppUpdateOnQuit({
      currentVersion: app.getVersion(),
      releaseChannel: settings.releaseChannel,
      signal,
    });
  },
  createUpdateDeadlineSignal: () => AbortSignal.timeout(UPDATE_QUIT_DEADLINE_MS),
  onStopError: (error) => {
    log.error("[desktop daemon] failed to stop managed daemon on quit", error);
  },
  onUpdateError: (error) => {
    log.error("[auto-updater] failed to validate downloaded update on quit", error);
  },
});

// The Pimi updater signals the quit lifecycle through Electron's autoUpdater.
electronAutoUpdater.on("before-quit-for-update", () => {
  log.info("[auto-updater] before-quit-for-update", {
    currentVersion: app.getVersion(),
  });
  quitLifecycle.handleBeforeQuitForUpdate();
});
app.on("before-quit", quitLifecycle.handleBeforeQuit);
app.on("before-quit", () => void flushDesktopNetworkLog());
registerExternalQuitSignals({ signals: process, quit: () => app.quit() });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
