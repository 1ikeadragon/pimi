import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { NetworkActivitySnapshot } from "@pimi/protocol/messages";
import type { BrowserKeyboardPolicy } from "./features/browser-keyboard/index.js";
import type { DesktopWindowChromeMode } from "./window/chrome.js";
import type { PimiAppearance, PimiContentBounds, PimiDestination } from "./window/pimi-window.js";
import type {
  PimiActivitySection,
  PimiReviewSummary,
  PimiVoiceBubbleState,
  PimiVoiceCommandInput,
  PimiVoiceResult,
  PimiWorkspaceSection,
} from "@pimi/protocol/pimi-task";

// This preload runs in Electron's sandbox and is tsc-compiled (not bundled), so it MUST
// NOT emit any runtime module load other than "electron" — a require() of a local or
// third-party module throws and aborts the preload before exposeInMainWorld runs, leaving
// window.pimiDesktop undefined (the 0.1.108 regression, #2103). Keep this literal in sync
// with PIMI_BROWSER_PROFILE_PARTITION in features/browser-profile.ts; preload-sandbox.test.ts
// guards both the no-local-import rule and this drift. Type-only imports are fine (erased at emit).
const PIMI_BROWSER_PROFILE_PARTITION = "persist:pimi-browser";
const consoleUrlPrefix = "--pimi-console-url=";
const expectedConsole = process.argv.find((argument) => argument.startsWith(consoleUrlPrefix));
const expected = expectedConsole && URL.parse(expectedConsole.slice(consoleUrlPrefix.length));
const documentUrl = URL.parse(globalThis.location.href);
if (
  !process.isMainFrame ||
  !expected ||
  !documentUrl ||
  expected.protocol !== documentUrl.protocol ||
  expected.host !== documentUrl.host ||
  documentUrl.username ||
  documentUrl.password
) {
  throw new Error("The desktop bridge is only available in the app console.");
}

type EventHandler = (payload: unknown) => void;

function readWindowChromeMode(): DesktopWindowChromeMode {
  const prefix = "--pimi-window-chrome-mode=";
  const value = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  if (value === "native-mac" || value === "custom-windows" || value === "custom-linux") {
    return value;
  }
  throw new Error("The desktop main process did not pass a window chrome mode.");
}

interface AttachedBrowserRegistration {
  browserId: string;
  workspaceId: string;
  webContentsId: number;
}

function createPimiAppearanceBridge() {
  const prefix = "--pimi-appearance=";
  const initial = process.argv
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
  if (!isPimiAppearance(initial)) return undefined;
  let current = initial;
  const subscribers = new Set<(mode: PimiAppearance) => void>();
  ipcRenderer.on("pimi:appearance:change", (_event, mode: unknown) => {
    if (!isPimiAppearance(mode)) return;
    current = mode;
    for (const subscriber of subscribers) subscriber(current);
  });
  return {
    get: () => current,
    set: (mode: PimiAppearance): Promise<void> => ipcRenderer.invoke("pimi:appearance:set", mode),
    subscribe: (subscriber: (mode: PimiAppearance) => void) => {
      subscribers.add(subscriber);
      subscriber(current);
      return () => {
        subscribers.delete(subscriber);
      };
    },
  };
}

function isPimiAppearance(value: unknown): value is PimiAppearance {
  return (
    value === "system" ||
    value === "light" ||
    value === "dark" ||
    value === "paper" ||
    value === "sakura" ||
    value === "cel-night" ||
    value === "ayu-light" ||
    value === "one-dark" ||
    value === "nord" ||
    value === "gruvbox" ||
    value === "catppuccin-mocha"
  );
}

const pimiAppearance = createPimiAppearanceBridge();
let settingsPending = false;
let openSettings: (() => void) | undefined;
let workspaceSection: PimiWorkspaceSection | null = null;
const workspaceListeners = new Set<() => void>();
if (pimiAppearance) {
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      document.title = "Pimi";
    },
    { once: true },
  );
  ipcRenderer.on("pimi:settings:open", () => {
    if (openSettings) openSettings();
    else settingsPending = true;
  });
  ipcRenderer.on("pimi:workspace:section", (_event, section: PimiWorkspaceSection | null) => {
    workspaceSection = section;
    for (const listener of workspaceListeners) listener();
  });
}
contextBridge.exposeInMainWorld("pimiDesktop", {
  platform: process.platform,
  pimiAppearance,
  ...(pimiAppearance
    ? {
        getPimiGitAuthStatus: (provider: "github" | "gitlab") =>
          ipcRenderer.invoke("pimi:forge:auth-status", provider),
        showPimiWorkspace: (destination: PimiDestination) =>
          ipcRenderer.send("pimi:workspace:show", destination),
        getPimiReviewSummary: (checkout: string): Promise<PimiReviewSummary | null> =>
          ipcRenderer.invoke("pimi:review:summary", checkout),
        onPimiWorkspaceActivity: (listener: (section: PimiActivitySection) => void) => {
          const onChange = (_event: Electron.IpcRendererEvent, section: PimiActivitySection) =>
            listener(section);
          ipcRenderer.on("pimi:workspace:activity", onChange);
          return () => ipcRenderer.removeListener("pimi:workspace:activity", onChange);
        },
        dismissPimiWorkspace: () => ipcRenderer.send("pimi:workspace:dismiss"),
        closePimiWorkspaceDialog: (): Promise<boolean> =>
          ipcRenderer.invoke("pimi:workspace:close-dialog"),
        setPimiContentBounds: (bounds: PimiContentBounds) =>
          ipcRenderer.send("pimi:workspace:content-bounds", bounds),
        pimiWorkspaceSection: {
          get: () => workspaceSection,
          subscribe: (listener: () => void) => {
            workspaceListeners.add(listener);
            return () => {
              workspaceListeners.delete(listener);
            };
          },
        },
        onPimiWorkspaceClick: (listener: () => void) => {
          const onClick = () => listener();
          ipcRenderer.on("pimi:workspace:click", onClick);
          return () => {
            ipcRenderer.removeListener("pimi:workspace:click", onClick);
          };
        },
        pimiVoice: {
          runCommand: (input: PimiVoiceCommandInput): Promise<PimiVoiceResult> =>
            ipcRenderer.invoke("pimi:voice:command", input),
          onStatus: (report: (status: string) => void) => {
            const listener = (_event: unknown, status: unknown) => {
              if (typeof status === "string") report(status);
            };
            ipcRenderer.on("pimi:voice:status", listener);
            return () => ipcRenderer.removeListener("pimi:voice:status", listener);
          },
          publish: (state: PimiVoiceBubbleState) => ipcRenderer.send("pimi:voice:state", state),
          onToggle: (toggle: () => void) => {
            const listener = () => toggle();
            ipcRenderer.on("pimi:voice:toggle", listener);
            return () => ipcRenderer.removeListener("pimi:voice:toggle", listener);
          },
          onPause: (pause: () => void) => {
            const listener = () => pause();
            ipcRenderer.on("pimi:voice:pause", listener);
            return () => ipcRenderer.removeListener("pimi:voice:pause", listener);
          },
          onDismissReceipt: (dismiss: () => void) => {
            const listener = () => dismiss();
            ipcRenderer.on("pimi:voice:dismiss-receipt", listener);
            return () => ipcRenderer.removeListener("pimi:voice:dismiss-receipt", listener);
          },
        },
        onPimiOpenSettings: (open: () => void) => {
          openSettings = open;
          if (settingsPending) {
            settingsPending = false;
            open();
          }
          return () => {
            if (openSettings === open) openSettings = undefined;
          };
        },
      }
    : {}),
  windowChromeMode: readWindowChromeMode(),
  networkActivity: {
    list: (input: { includeLocal?: boolean; limit?: number }): Promise<NetworkActivitySnapshot> =>
      ipcRenderer.invoke("pimi:network-activity:list", input),
    processes: (): Promise<{ rootPid: number; processes: { pid: number; label: string }[] }> =>
      ipcRenderer.invoke("pimi:network-activity:processes"),
    openLogsFolder: (): Promise<void> =>
      ipcRenderer.invoke("pimi:network-activity:open-logs-folder"),
  },
  invoke: (command: string, args?: Record<string, unknown>) =>
    ipcRenderer.invoke("pimi:invoke", command, args),
  getPendingOpenProject: () =>
    ipcRenderer.invoke("pimi:get-pending-open-project") as Promise<string | null>,
  agentNavigation: {
    ready: () =>
      ipcRenderer.invoke("pimi:agent-navigation:ready") as Promise<{
        serverId: string;
        agentId: string;
      } | null>,
  },
  events: {
    on: (event: string, handler: EventHandler): Promise<() => void> => {
      const listener = (_ipcEvent: Electron.IpcRendererEvent, payload: unknown) => {
        handler(payload);
      };
      ipcRenderer.on(`pimi:event:${event}`, listener);
      return Promise.resolve(() => {
        ipcRenderer.removeListener(`pimi:event:${event}`, listener);
      });
    },
  },
  window: {
    openNew: (options?: { pendingOpenProjectPath?: string | null }) =>
      ipcRenderer.invoke("pimi:window:openNew", options),
    getCurrentWindow: () => ({
      minimize: () => ipcRenderer.invoke("pimi:window:minimize"),
      close: () => ipcRenderer.invoke("pimi:window:close"),
      toggleMaximize: () => ipcRenderer.invoke("pimi:window:toggleMaximize"),
      isMaximized: () => ipcRenderer.invoke("pimi:window:isMaximized"),
      setFullscreen: (fullscreen: boolean) =>
        ipcRenderer.invoke("pimi:window:setFullscreen", fullscreen),
      isFullscreen: () => ipcRenderer.invoke("pimi:window:isFullscreen"),
      updateChrome: (update: { backgroundColor?: string; trafficLightOffsetY?: number }) =>
        ipcRenderer.invoke("pimi:window:updateChrome", update),
      onResized: (handler: EventHandler): (() => void) => {
        const listener = (_ipcEvent: Electron.IpcRendererEvent, payload: unknown) => {
          handler(payload);
        };
        ipcRenderer.on("pimi:window:resized", listener);
        return () => {
          ipcRenderer.removeListener("pimi:window:resized", listener);
        };
      },
      setBadgeCount: (count?: number) => ipcRenderer.invoke("pimi:window:setBadgeCount", count),
      setAgentsRunning: (running: boolean) =>
        ipcRenderer.invoke("pimi:window:setAgentsRunning", running),
    }),
  },
  dialog: {
    ask: (message: string, options?: Record<string, unknown>) =>
      ipcRenderer.invoke("pimi:dialog:ask", message, options),
    askWithCheckbox: (message: string, options: Record<string, unknown>) =>
      ipcRenderer.invoke("pimi:dialog:askWithCheckbox", message, options),
    open: (options?: Record<string, unknown>) => ipcRenderer.invoke("pimi:dialog:open", options),
  },
  notification: {
    isSupported: () => ipcRenderer.invoke("pimi:notification:isSupported"),
    sendNotification: (payload: { title: string; body?: string; data?: Record<string, unknown> }) =>
      ipcRenderer.invoke("pimi:notification:send", payload),
  },
  opener: {
    openUrl: (url: string) => ipcRenderer.invoke("pimi:opener:openUrl", url),
  },
  editor: {
    listTargets: (input?: { workspacePath?: string }) =>
      ipcRenderer.invoke("pimi:editor:listTargets", input),
    openTarget: (input: {
      editorId: string;
      workspacePath: string;
      filePath?: string;
      line?: number;
      column?: number;
    }) => ipcRenderer.invoke("pimi:editor:openTarget", input),
  },
  webUtils: {
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
  },
  menu: {
    showContextMenu: (input?: Record<string, unknown>) =>
      ipcRenderer.invoke("pimi:menu:showContextMenu", input),
    setCapturingShortcut: (capturing: boolean) =>
      ipcRenderer.invoke("pimi:menu:set-capturing-shortcut", capturing),
  },
  desktopTarget: {
    permissions: (input?: { prompt?: boolean }) =>
      ipcRenderer.invoke("pimi:desktop-target:permissions", input),
    listWindows: () => ipcRenderer.invoke("pimi:desktop-target:list-windows"),
    execute: (request: Record<string, unknown>) =>
      ipcRenderer.invoke("pimi:desktop-target:execute", request),
    resolveScope: (request: Record<string, unknown>) =>
      ipcRenderer.invoke("pimi:desktop-target:scope", request),
    checkDataDir: (dir: string) => ipcRenderer.invoke("pimi:desktop-target:check-data-dir", dir),
    openSettings: (pane: "accessibility" | "screen") =>
      ipcRenderer.invoke("pimi:desktop-target:open-settings", pane),
    relaunch: () => ipcRenderer.invoke("pimi:desktop-target:relaunch"),
  },
  browser: {
    setShortcutPolicy: (input: BrowserKeyboardPolicy) =>
      ipcRenderer.invoke("pimi:browser:set-shortcut-policy", input),
    profilePartition: PIMI_BROWSER_PROFILE_PARTITION,
    registerAttachedBrowser: (input: AttachedBrowserRegistration) =>
      ipcRenderer.invoke("pimi:browser:register-attached", input),
    unregisterWorkspaceBrowser: (browserId: string) =>
      ipcRenderer.invoke("pimi:browser:unregister-workspace-browser", browserId),
    setWorkspaceActiveBrowser: (input: { workspaceId: string; browserId: string | null }) =>
      ipcRenderer.invoke("pimi:browser:set-workspace-active-browser", input),
    setAttackPolicy: (input: { browserId: string; runId: string; allowedHosts: string[] }) =>
      ipcRenderer.invoke("pimi:browser:set-attack-policy", input),
    focus: (browserId: string) => ipcRenderer.invoke("pimi:browser:focus", browserId),
    openDevTools: (browserId: string) =>
      ipcRenderer.invoke("pimi:browser:open-devtools", browserId),
    clearProfile: (legacyBrowserIds: string[]) =>
      ipcRenderer.invoke("pimi:browser:clear-profile", legacyBrowserIds),
    executeAutomationCommand: (request: Record<string, unknown>) =>
      ipcRenderer.invoke("pimi:browser:execute-automation-command", request),
    captureElement: (
      browserId: string,
      rect: { x: number; y: number; width: number; height: number },
    ) => ipcRenderer.invoke("pimi:browser:capture-element", browserId, rect),
    copyElement: (payload: { text?: string; imageDataUrl?: string }) =>
      ipcRenderer.invoke("pimi:browser:copy-element", payload),
  },
});
