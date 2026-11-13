import { Platform } from "react-native";
import { getElectronHost } from "@/desktop/electron/host";
import type { BrowserKeyboardPolicy } from "@/keyboard";
import type { PIMI_APPEARANCE_THEMES } from "@/styles/theme";
import type { AttackDesktopTarget } from "@pimi/protocol/attack/types";
import type {
  NetworkActivitySnapshot,
  SessionInboundMessage,
  SessionOutboundMessage,
} from "@pimi/protocol/messages";
import type {
  PimiActivitySection,
  PimiDestination,
  PimiLinkedLabels,
  PimiRecap,
  PimiRecapPeriod,
  PimiReportLinkTarget,
  PimiReportLinkError,
  PimiReviewRequest,
  PimiReviewSummary,
  PimiVoiceBubbleState,
  PimiVoiceCommandInput,
  PimiVoiceResult,
  PimiWorkspaceSection,
} from "@pimi/protocol/pimi-task";

type BrowserAutomationExecuteRequest = Extract<
  SessionOutboundMessage,
  { type: "browser.automation.execute.request" }
>;
type BrowserAutomationExecuteResponse = Extract<
  SessionInboundMessage,
  { type: "browser.automation.execute.response" }
>;

export type DesktopNotificationPermission = "granted" | "denied" | "default";
export type DesktopWindowChromeMode = "native-mac" | "custom-windows" | "custom-linux";

export interface DesktopDialogAskOptions {
  title?: string;
  okLabel?: string;
  cancelLabel?: string;
  kind?: "info" | "warning" | "error";
}

export interface DesktopDialogOpenOptions {
  title?: string;
  defaultPath?: string;
  directory?: boolean;
  createDirectory?: boolean;
  multiple?: boolean;
  filters?: Array<{
    name: string;
    extensions: string[];
  }>;
}

export interface DesktopDialogAskWithCheckboxOptions extends DesktopDialogAskOptions {
  checkboxLabel: string;
  checkboxChecked?: boolean;
}

export interface DesktopDialogAskWithCheckboxResult {
  confirmed: boolean;
  dontAskAgain: boolean;
}

export interface DesktopDialogBridge {
  ask?: (message: string, options?: DesktopDialogAskOptions) => Promise<boolean>;
  askWithCheckbox?: (
    message: string,
    options: DesktopDialogAskWithCheckboxOptions,
  ) => Promise<DesktopDialogAskWithCheckboxResult>;
  open?: (options?: DesktopDialogOpenOptions) => Promise<string | string[] | null>;
}

export interface DesktopNotificationBridge {
  isSupported?: () => Promise<boolean>;
  sendNotification?: (
    payload: string | { title: string; body?: string; data?: Record<string, unknown> },
  ) => Promise<boolean>;
}

export interface DesktopOpenerBridge {
  openUrl?: (url: string) => Promise<void>;
}

export interface DesktopEditorTargetDescriptor {
  id: string;
  label: string;
  kind: "editor" | "file-manager";
  icon: { kind: "image"; dataUrl: string } | { kind: "symbol"; name: "folder" | "terminal" };
}

export interface DesktopEditorOpenTargetInput {
  editorId: string;
  workspacePath: string;
  filePath?: string;
  line?: number;
  column?: number;
}

export interface DesktopEditorBridge {
  listTargets?: (input?: { workspacePath?: string }) => Promise<DesktopEditorTargetDescriptor[]>;
  openTarget?: (input: DesktopEditorOpenTargetInput) => Promise<void>;
}

export interface DesktopWebUtilsBridge {
  getPathForFile?: (file: File) => string;
}

export interface DesktopMenuBridge {
  showContextMenu?: (input?: { kind?: "terminal"; hasSelection?: boolean }) => Promise<void>;
  setCapturingShortcut?: (capturing: boolean) => Promise<void>;
}

export interface DesktopWindowChromeUpdate {
  backgroundColor?: string;
  trafficLightOffsetY?: number;
}

export interface DesktopWindowBridge {
  label?: string;
  minimize?: () => Promise<void>;
  close?: () => Promise<void>;
  toggleMaximize?: () => Promise<void>;
  isMaximized?: () => Promise<boolean>;
  setFullscreen?: (fullscreen: boolean) => Promise<void>;
  isFullscreen?: () => Promise<boolean>;
  updateChrome?: (update: DesktopWindowChromeUpdate) => Promise<void>;
  onResized?: <TEvent = unknown>(
    handler: (event: TEvent) => void,
  ) => Promise<() => void> | (() => void);
  setBadgeCount?: (count?: number) => Promise<void>;
  setAgentsRunning?: (running: boolean) => Promise<void>;
  onDragDropEvent?: <TEvent = unknown>(
    handler: (event: TEvent) => void,
  ) => Promise<() => void> | (() => void);
}

export interface DesktopWindowModuleBridge {
  openNew?: (options?: { pendingOpenProjectPath?: string | null }) => Promise<void>;
  getCurrentWindow?: () => DesktopWindowBridge;
}

export interface DesktopEventsBridge {
  on?: (event: string, handler: (payload: unknown) => void) => Promise<() => void> | (() => void);
}

export interface DesktopAgentNavigationBridge {
  ready?: () => Promise<{ serverId: string; agentId: string } | null>;
}

export type DesktopBrowserShortcutEvent =
  | { browserId?: string; action: "focus-url" }
  /** Escape pressed in the page; the pane closes its Find if one is open. */
  | { browserId: string; action: "find-close" }
  | { browserId: string; action: "new-tab" };

export interface DesktopBrowserNewTabRequestEvent {
  sourceBrowserId: string;
  url: string;
}

export interface DesktopAttachedBrowserRegistration {
  browserId: string;
  workspaceId: string;
  webContentsId: number;
}

type DesktopTargetExecuteRequest = Extract<
  SessionOutboundMessage,
  { type: "desktop.target.execute.request" }
>;
type DesktopTargetExecuteResponse = Extract<
  SessionInboundMessage,
  { type: "desktop.target.execute.response" }
>;

export type DesktopTargetPermissions =
  | { supported: false }
  | {
      supported: true;
      /** Absent on older macOS-only builds; Windows has no OS permissions to grant. */
      platform?: "darwin" | "win32";
      accessibility: boolean;
      screen: "granted" | "denied" | "not-determined" | "restricted" | "unknown";
      /** Only known after a prompt-time probe; macOS has no query for it. */
      automation: "unknown" | "granted" | "denied" | "failed";
    };

export interface DesktopTargetWindow {
  bundleId: string;
  appName: string;
  windowTitle: string;
  platform?: AttackDesktopTarget["platform"];
  /** Windows only: the UI framework, from the window class and UIA. */
  framework?: string;
  /** Windows only: the process runs as administrator and cannot be driven. */
  elevated?: boolean;
  /** Windows only: listed but never driven. */
  blocked?: string | null;
  // The picker lists no data dirs; the launch form resolves them (resolveScope).
  win?: Omit<NonNullable<AttackDesktopTarget["win"]>, "dataDirs"> | null;
}

/** Attack's desktop target: the main process names windows and drives the one the guard allows. */
export interface DesktopTargetBridge {
  permissions: (input?: { prompt?: boolean }) => Promise<DesktopTargetPermissions>;
  listWindows: () => Promise<
    | { ok: true; windows: DesktopTargetWindow[] }
    | { ok: false; error: string | { code: string; message: string } }
  >;
  execute: (
    request: DesktopTargetExecuteRequest,
  ) => Promise<DesktopTargetExecuteResponse["payload"]>;
  /** Windows: the install dir and candidate data dirs of a picked window, for the launch form. */
  resolveScope: (request: {
    bundleId: string;
    windowTitle: string;
    win: { hwnd: string; pid: number; processStartedAt: string | null; windowClass: string };
  }) => Promise<
    { ok: true; installDir: string | null; dataDirs: string[] } | { ok: false; error: string }
  >;
  /** Windows: the canonical form of a directory the owner typed, or null when it is not allowed. */
  checkDataDir: (dir: string) => Promise<string | null>;
  openSettings: (pane: "accessibility" | "screen" | "automation") => Promise<void>;
}

export interface DesktopBrowserBridge {
  setShortcutPolicy?: (input: BrowserKeyboardPolicy) => Promise<void>;
  readonly profilePartition?: string;
  registerAttachedBrowser?: (input: DesktopAttachedBrowserRegistration) => Promise<void>;
  unregisterWorkspaceBrowser?: (browserId: string) => Promise<void>;
  setWorkspaceActiveBrowser?: (input: {
    workspaceId: string;
    browserId: string | null;
  }) => Promise<void>;
  /** Confines an Attack run's tab to the run's hosts; the main process refuses the rest. */
  setAttackPolicy?: (input: {
    browserId: string;
    runId: string;
    allowedHosts: string[];
  }) => Promise<void>;
  focus?: (browserId: string) => Promise<boolean>;
  openDevTools?: (browserId: string) => Promise<unknown>;
  clearProfile?: (legacyBrowserIds: string[]) => Promise<void>;
  executeAutomationCommand?: (
    request: BrowserAutomationExecuteRequest,
  ) => Promise<BrowserAutomationExecuteResponse["payload"]>;
  /** Capture a PNG screenshot of the guest viewport cropped to `rect`. */
  captureElement?: (
    browserId: string,
    rect: { x: number; y: number; width: number; height: number },
  ) => Promise<string | null>;
  /** Copy element text and/or an image to the system clipboard from main. */
  copyElement?: (payload: { text?: string; imageDataUrl?: string }) => Promise<boolean>;
}

export interface DesktopInvokeBridge {
  invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
}

export type PimiAppearance = "system" | keyof typeof PIMI_APPEARANCE_THEMES;
export type PimiGitProvider = "github" | "gitlab";
export type PimiGitAuthStatus = "connected" | "cli-missing" | "unverified";

export interface DesktopNetworkActivityBridge {
  list: (input: { includeLocal?: boolean; limit?: number }) => Promise<NetworkActivitySnapshot>;
  /** Opens the folder holding the saved network logs in the system file manager. */
  openLogsFolder: () => Promise<void>;
}

export interface DesktopHostBridge {
  platform?: string;
  windowChromeMode?: DesktopWindowChromeMode;
  networkActivity?: DesktopNetworkActivityBridge;
  invoke?: DesktopInvokeBridge["invoke"];
  taskDictation?: { complete: (text: string | null) => void };
  getPimiGitAuthStatus?: (provider: PimiGitProvider) => Promise<PimiGitAuthStatus>;
  showPimiWorkspace?: (destination: PimiDestination) => void;
  getPimiReviewSummary?: (checkout: string) => Promise<PimiReviewSummary | null>;
  getPimiRecap?: (period: PimiRecapPeriod) => Promise<PimiRecap>;
  onPimiWorkspaceActivity?: (listener: (section: PimiActivitySection) => void) => () => void;
  dismissPimiWorkspace?: () => void;
  setPimiContentBounds?: (bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
    sidebar: boolean;
  }) => void;
  pimiLabels?: {
    get: () => Promise<PimiLinkedLabels>;
    subscribe: (listener: () => void) => () => void;
  };
  pimiWorkspaceSection?: {
    get: () => PimiWorkspaceSection | null;
    subscribe: (listener: () => void) => () => void;
  };
  /** The Work window asks to open Review for a checkout or a pull request. */
  onPimiReviewRequest?: (listener: (request: PimiReviewRequest) => void) => () => void;
  onPimiWorkspaceClick?: (listener: () => void) => () => void;
  pimiReportLinks?: {
    onOpen: (listener: (target: PimiReportLinkTarget) => void) => () => void;
    reportError: (error: PimiReportLinkError) => void;
  };
  pimiVoice?: {
    runCommand: (input: PimiVoiceCommandInput) => Promise<PimiVoiceResult>;
    /** Progress lines from the command now running, such as "Searching Spaces". */
    onStatus?: (report: (status: string) => void) => () => void;
    publish: (state: PimiVoiceBubbleState) => void;
    onToggle: (toggle: () => void) => () => void;
    onPause: (pause: () => void) => () => void;
    onDismissReceipt?: (dismiss: () => void) => () => void;
  };
  onPimiOpenSettings?: (open: () => void) => () => void;
  pimiAppearance?: {
    get: () => PimiAppearance;
    set: (mode: PimiAppearance) => Promise<void>;
    subscribe: (handler: (mode: PimiAppearance) => void) => () => void;
  };
  getPendingOpenProject?: () => Promise<string | null>;
  agentNavigation?: DesktopAgentNavigationBridge;
  events?: DesktopEventsBridge;
  window?: DesktopWindowModuleBridge;
  dialog?: DesktopDialogBridge;
  notification?: DesktopNotificationBridge;
  opener?: DesktopOpenerBridge;
  editor?: DesktopEditorBridge;
  webUtils?: DesktopWebUtilsBridge;
  menu?: DesktopMenuBridge;
  browser?: DesktopBrowserBridge;
  desktopTarget?: DesktopTargetBridge;
}

declare global {
  interface Window {
    pimiDesktop?: DesktopHostBridge;
  }
}

export function getDesktopHost(): DesktopHostBridge | null {
  if (Platform.OS !== "web") {
    return null;
  }
  return getElectronHost();
}

export function isElectronRuntime(): boolean {
  return getDesktopHost() !== null;
}

export function isElectronRuntimeMac(): boolean {
  if (!isElectronRuntime()) {
    return false;
  }
  if (typeof navigator === "undefined") {
    return false;
  }
  const hostPlatform = getDesktopHost()?.platform?.toLowerCase();
  if (hostPlatform === "darwin" || hostPlatform === "mac" || hostPlatform === "macos") {
    return true;
  }
  const ua = navigator.userAgent;
  return ua.includes("Mac OS") || ua.includes("Macintosh");
}

export function getDesktopWindowChromeMode(): DesktopWindowChromeMode | null {
  return getDesktopHost()?.windowChromeMode ?? null;
}

export function usesPimiMacTitlebar(): boolean {
  return (
    Boolean(getDesktopHost()?.showPimiWorkspace) && getDesktopWindowChromeMode() === "native-mac"
  );
}
