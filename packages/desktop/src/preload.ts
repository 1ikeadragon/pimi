import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { BrowserKeyboardPolicy } from "./features/browser-keyboard/index.js";
import type { DesktopWindowChromeMode } from "./window/chrome.js";
import type { PimiAppearance, PimiContentBounds, PimiDestination } from "./window/pimi-window.js";
import type {
  PimiActivitySection,
  PimiLinkedLabels,
  PimiRecap,
  PimiRecapPeriod,
  PimiReportLinkTarget,
  PimiReportLinkError,
  PimiReviewSummary,
  PimiVoiceBubbleState,
  PimiVoiceCommandInput,
  PimiVoiceResult,
  PimiWorkspaceSection,
} from "@getpaseo/protocol/pimi-task";

// This preload runs in Electron's sandbox and is tsc-compiled (not bundled), so it MUST
// NOT emit any runtime module load other than "electron" — a require() of a local or
// third-party module throws and aborts the preload before exposeInMainWorld runs, leaving
// window.paseoDesktop undefined (the 0.1.108 regression, #2103). Keep this literal in sync
// with PASEO_BROWSER_PROFILE_PARTITION in features/browser-profile.ts; preload-sandbox.test.ts
// guards both the no-local-import rule and this drift. Type-only imports are fine (erased at emit).
const PASEO_BROWSER_PROFILE_PARTITION = "persist:paseo-browser";

type EventHandler = (payload: unknown) => void;

function readWindowChromeMode(): DesktopWindowChromeMode {
  const prefix = "--paseo-window-chrome-mode=";
  const value = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  if (value === "native-mac" || value === "custom-windows" || value === "custom-linux") {
    return value;
  }
  // COMPAT(windowChromeMode): added in v0.5.3; remove after 2026-11-25.
  if (process.platform === "darwin") return "native-mac";
  return process.platform === "linux" ? "custom-linux" : "custom-windows";
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
  return value === "system" || value === "light" || value === "dark" || value === "paper";
}

const pimiAppearance = createPimiAppearanceBridge();
const isTaskDictation = process.argv.includes("--pimi-task-dictation");
if (isTaskDictation) {
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      document.documentElement.dataset.pimiDictation = "";
    },
    { once: true },
  );
}
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
contextBridge.exposeInMainWorld("paseoDesktop", {
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
        getPimiRecap: (period: PimiRecapPeriod): Promise<PimiRecap> =>
          ipcRenderer.invoke("pimi:recap:get", period),
        onPimiWorkspaceActivity: (listener: (section: PimiActivitySection) => void) => {
          const onChange = (_event: Electron.IpcRendererEvent, section: PimiActivitySection) =>
            listener(section);
          ipcRenderer.on("pimi:workspace:activity", onChange);
          return () => ipcRenderer.removeListener("pimi:workspace:activity", onChange);
        },
        dismissPimiWorkspace: () => ipcRenderer.send("pimi:workspace:dismiss"),
        setPimiContentBounds: (bounds: PimiContentBounds) =>
          ipcRenderer.send("pimi:workspace:content-bounds", bounds),
        pimiLabels: {
          get: (): Promise<PimiLinkedLabels> => ipcRenderer.invoke("pimi:labels:get"),
          subscribe: (listener: () => void) => {
            const onChange = () => listener();
            ipcRenderer.on("pimi:labels:changed", onChange);
            return () => ipcRenderer.removeListener("pimi:labels:changed", onChange);
          },
        },
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
        pimiReportLinks: {
          onOpen: (listener: (target: PimiReportLinkTarget) => void) => {
            const onOpen = (_event: Electron.IpcRendererEvent, target: PimiReportLinkTarget) =>
              listener(target);
            ipcRenderer.on("pimi:workspace:open-report-link", onOpen);
            return () => ipcRenderer.removeListener("pimi:workspace:open-report-link", onOpen);
          },
          reportError: (error: PimiReportLinkError) =>
            ipcRenderer.send("pimi:workspace:report-link-error", error),
        },
        pimiVoice: {
          runCommand: (input: PimiVoiceCommandInput): Promise<PimiVoiceResult> =>
            ipcRenderer.invoke("pimi:voice:command", input),
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
  ...(isTaskDictation
    ? {
        taskDictation: {
          complete: (text: string | null) => ipcRenderer.send("pimi:task-dictation:complete", text),
        },
      }
    : {}),
  windowChromeMode: readWindowChromeMode(),
  invoke: (command: string, args?: Record<string, unknown>) =>
    ipcRenderer.invoke("paseo:invoke", command, args),
  getPendingOpenProject: () =>
    ipcRenderer.invoke("paseo:get-pending-open-project") as Promise<string | null>,
  agentNavigation: {
    ready: () =>
      ipcRenderer.invoke("paseo:agent-navigation:ready") as Promise<{
        serverId: string;
        agentId: string;
      } | null>,
  },
  events: {
    on: (event: string, handler: EventHandler): Promise<() => void> => {
      const listener = (_ipcEvent: Electron.IpcRendererEvent, payload: unknown) => {
        handler(payload);
      };
      ipcRenderer.on(`paseo:event:${event}`, listener);
      return Promise.resolve(() => {
        ipcRenderer.removeListener(`paseo:event:${event}`, listener);
      });
    },
  },
  window: {
    openNew: (options?: { pendingOpenProjectPath?: string | null }) =>
      ipcRenderer.invoke("paseo:window:openNew", options),
    getCurrentWindow: () => ({
      minimize: () => ipcRenderer.invoke("paseo:window:minimize"),
      close: () => ipcRenderer.invoke("paseo:window:close"),
      toggleMaximize: () => ipcRenderer.invoke("paseo:window:toggleMaximize"),
      isMaximized: () => ipcRenderer.invoke("paseo:window:isMaximized"),
      setFullscreen: (fullscreen: boolean) =>
        ipcRenderer.invoke("paseo:window:setFullscreen", fullscreen),
      isFullscreen: () => ipcRenderer.invoke("paseo:window:isFullscreen"),
      updateChrome: (update: { backgroundColor?: string; trafficLightOffsetY?: number }) =>
        ipcRenderer.invoke("paseo:window:updateChrome", update),
      onResized: (handler: EventHandler): (() => void) => {
        const listener = (_ipcEvent: Electron.IpcRendererEvent, payload: unknown) => {
          handler(payload);
        };
        ipcRenderer.on("paseo:window:resized", listener);
        return () => {
          ipcRenderer.removeListener("paseo:window:resized", listener);
        };
      },
      setBadgeCount: (count?: number) => ipcRenderer.invoke("paseo:window:setBadgeCount", count),
    }),
  },
  dialog: {
    ask: (message: string, options?: Record<string, unknown>) =>
      ipcRenderer.invoke("paseo:dialog:ask", message, options),
    askWithCheckbox: (message: string, options: Record<string, unknown>) =>
      ipcRenderer.invoke("paseo:dialog:askWithCheckbox", message, options),
    open: (options?: Record<string, unknown>) => ipcRenderer.invoke("paseo:dialog:open", options),
  },
  notification: {
    isSupported: () => ipcRenderer.invoke("paseo:notification:isSupported"),
    sendNotification: (payload: { title: string; body?: string; data?: Record<string, unknown> }) =>
      ipcRenderer.invoke("paseo:notification:send", payload),
  },
  opener: {
    openUrl: (url: string) => ipcRenderer.invoke("paseo:opener:openUrl", url),
  },
  editor: {
    listTargets: (input?: { workspacePath?: string }) =>
      ipcRenderer.invoke("paseo:editor:listTargets", input),
    openTarget: (input: {
      editorId: string;
      workspacePath: string;
      filePath?: string;
      line?: number;
      column?: number;
    }) => ipcRenderer.invoke("paseo:editor:openTarget", input),
  },
  webUtils: {
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
  },
  menu: {
    showContextMenu: (input?: Record<string, unknown>) =>
      ipcRenderer.invoke("paseo:menu:showContextMenu", input),
    setCapturingShortcut: (capturing: boolean) =>
      ipcRenderer.invoke("paseo:menu:set-capturing-shortcut", capturing),
  },
  browser: {
    setShortcutPolicy: (input: BrowserKeyboardPolicy) =>
      ipcRenderer.invoke("paseo:browser:set-shortcut-policy", input),
    profilePartition: PASEO_BROWSER_PROFILE_PARTITION,
    registerAttachedBrowser: (input: AttachedBrowserRegistration) =>
      ipcRenderer.invoke("paseo:browser:register-attached", input),
    unregisterWorkspaceBrowser: (browserId: string) =>
      ipcRenderer.invoke("paseo:browser:unregister-workspace-browser", browserId),
    setWorkspaceActiveBrowser: (input: { workspaceId: string; browserId: string | null }) =>
      ipcRenderer.invoke("paseo:browser:set-workspace-active-browser", input),
    focus: (browserId: string) => ipcRenderer.invoke("paseo:browser:focus", browserId),
    openDevTools: (browserId: string) =>
      ipcRenderer.invoke("paseo:browser:open-devtools", browserId),
    clearProfile: (legacyBrowserIds: string[]) =>
      ipcRenderer.invoke("paseo:browser:clear-profile", legacyBrowserIds),
    executeAutomationCommand: (request: Record<string, unknown>) =>
      ipcRenderer.invoke("paseo:browser:execute-automation-command", request),
    captureElement: (
      browserId: string,
      rect: { x: number; y: number; width: number; height: number },
    ) => ipcRenderer.invoke("paseo:browser:capture-element", browserId, rect),
    copyElement: (payload: { text?: string; imageDataUrl?: string }) =>
      ipcRenderer.invoke("paseo:browser:copy-element", payload),
  },
});
