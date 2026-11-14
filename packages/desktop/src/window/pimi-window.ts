// Pimi. PolyForm-Noncommercial-1.0.0.
import { app, BrowserWindow, nativeTheme, shell, WebContentsView } from "electron";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readLocalCredentialForTarget } from "@pimi/server/daemon-control";
import { parseAgentDeepLink, type AgentDeepLinkTarget } from "@pimi/protocol/agent-deep-link";
import { isPimiArxivEmbed, isPimiSpaceEmbed, parsePimiSpaceUrl } from "@pimi/protocol/pimi-task";
import type {
  PimiActivitySection,
  PimiDestination as ProtocolPimiDestination,
  PimiReviewSummary,
  PimiVoiceBubbleState,
  PimiVoiceCommandInput,
  PimiVoiceResult,
  PimiWorkspaceSection,
} from "@pimi/protocol/pimi-task";
import type { TaskImportRecord } from "@pimi/protocol/task/types";
import { resolveDesktopDaemonStatus } from "../daemon/daemon-manager.js";
import { createPimiWorkspaceSession } from "./pimi-workspace-session.js";

const AGENT_CONSOLE_URL = "pimi-agents://open";
const APPEARANCE_FILE = "pimi-appearance.json";
// The page keeps Memory and Spaces; tasks and Review are native app screens.
export type PimiDestination = Extract<ProtocolPimiDestination, { view: "memory" | "spaces" }>;
type PageSection = Extract<PimiWorkspaceSection, "memory" | "spaces">;
const DESTINATION_SECTIONS: Record<PimiDestination["view"], PageSection> = {
  memory: "memory",
  spaces: "spaces",
};
const PIMI_APPEARANCES = [
  "system",
  "light",
  "dark",
  "paper",
  "sakura",
  "cel-night",
  "ayu-light",
  "one-dark",
  "nord",
  "gruvbox",
  "catppuccin-mocha",
] as const;
export type PimiAppearance = (typeof PIMI_APPEARANCES)[number];

const PIMI_APPEARANCE_BACKGROUNDS: Record<Exclude<PimiAppearance, "system">, string> = {
  light: "#faf7f6",
  dark: "#232224",
  paper: "#f7f2e8",
  sakura: "#f7edf5",
  "cel-night": "#171a2c",
  "ayu-light": "#f3f4f5",
  "one-dark": "#21252b",
  nord: "#292f3a",
  gruvbox: "#212323",
  "catppuccin-mocha": "#181825",
};

function isPimiAppearance(value: unknown): value is PimiAppearance {
  return PIMI_APPEARANCES.some((mode) => mode === value);
}
export type WorkspaceLayout = "inline" | "attached" | "hidden";
export interface PimiContentBounds extends Electron.Rectangle {
  sidebar: boolean;
}
interface WorkspaceSurface {
  view: WebContentsView;
  host?: BrowserWindow;
  owner?: BrowserWindow;
  releaseHost?: () => void;
  resizeHost?: () => void;
  options: PimiWindowOptions;
  layout: WorkspaceLayout;
  section: PageSection;
  dialogOpen: boolean;
}
let workspace: WorkspaceSurface | undefined;
let workspaceRuntime: Promise<PimiRuntimeResult> | undefined;
let opening: Promise<WorkspaceSurface> | undefined;
let requestedOwner: BrowserWindow | undefined;
let navigationRequest = 0;
let appearanceWrites: Promise<void> = Promise.resolve();
const consoleBounds = new WeakMap<BrowserWindow, PimiContentBounds>();
const voiceBubbleStates = new WeakMap<BrowserWindow, PimiVoiceBubbleState>();
const VOICE_OFF: PimiVoiceBubbleState = { visible: false, active: false, status: "", level: 0 };

export function updatePimiVoiceBubble(win: BrowserWindow, state: PimiVoiceBubbleState): void {
  voiceBubbleStates.set(win, state);
  if (workspace?.host === win && !workspace.view.webContents.isDestroyed()) {
    workspace.view.webContents.send("pimi:voice:state", state);
  }
}

export function updatePimiContentBounds(win: BrowserWindow, bounds: PimiContentBounds): void {
  consoleBounds.set(win, bounds);
  if (workspace?.host === win) workspace.resizeHost?.();
}

function getPimiAppearance(): PimiAppearance {
  try {
    const value: unknown = JSON.parse(
      readFileSync(path.join(app.getPath("userData"), APPEARANCE_FILE), "utf8"),
    );
    if (isPimiAppearance(value)) return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("Could not read Pimi appearance:", error);
    }
  }
  return "system";
}

export async function setPimiAppearance(mode: unknown): Promise<void> {
  if (!isPimiAppearance(mode)) {
    throw new Error("Choose a supported appearance.");
  }
  const save = appearanceWrites.then(async () => {
    const directory = app.getPath("userData");
    const file = path.join(directory, APPEARANCE_FILE);
    const temporary = file + ".tmp";
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, JSON.stringify(mode), { mode: 0o600 });
    await rename(temporary, file);
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send("pimi:appearance:change", mode);
    }
    const contents = workspace?.view.webContents;
    if (contents && !contents.isDestroyed()) contents.send("pimi:appearance:change", mode);
    return undefined;
  });
  appearanceWrites = save.catch(() => undefined);
  await save;
}

export function pimiAppearanceArgument(): string {
  return `--pimi-appearance=${getPimiAppearance()}`;
}

interface PimiRuntimeResult {
  origin: string;
  observeWorkspaces(): Promise<void>;
  importTasks(tasks: TaskImportRecord[]): Promise<{ imported: number; skipped: number }>;
  localServerId(): Promise<string>;
  runVoiceCommand(
    input: PimiVoiceCommandInput,
    onStatus: (status: string) => void,
  ): Promise<PimiVoiceResult>;
  close(): Promise<void>;
}

export async function getPimiReviewSummary(
  runtimeDir: string,
  checkout: string,
): Promise<PimiReviewSummary | null> {
  const entry = pathToFileURL(path.join(runtimeDir, "pimi", "git.mjs")).href;
  const { summarizeReviewDirectory } = (await import(entry)) as {
    summarizeReviewDirectory(path: string): Promise<PimiReviewSummary | null>;
  };
  return summarizeReviewDirectory(checkout);
}

interface PimiRuntime {
  startPimi(options: {
    native: boolean;
    dataHome: string;
    getAppearance: () => PimiAppearance;
    connection: () => Promise<DesktopDaemonConnection>;
    onActivity: (section: PimiActivitySection) => void;
  }): Promise<PimiRuntimeResult>;
}

interface PimiWindowOptions {
  runtimeDir: string;
  resolveConsoleWindow: (preferred?: BrowserWindow) => Promise<BrowserWindow>;
  openAgentChat: (target: AgentDeepLinkTarget) => void;
  workspacePreload: string;
}

export interface DesktopDaemonConnection {
  url: string;
  credential?: string;
  localDataCredential?: string;
}

export async function connectToDesktopDaemon(): Promise<DesktopDaemonConnection> {
  if (process.env.PIMI_DESKTOP_DAEMON_URL) return { url: process.env.PIMI_DESKTOP_DAEMON_URL };
  const status = await resolveDesktopDaemonStatus();
  const endpoint = status.listen ?? process.env.PIMI_LISTEN ?? "127.0.0.1:6767";
  const local = readLocalCredentialForTarget(status.home, endpoint) ?? undefined;
  return {
    url: `ws://${endpoint}/ws`,
    credential: status.desktopManaged ? local : undefined,
    localDataCredential: local,
  };
}

export async function showPimiWindow(
  options: PimiWindowOptions,
  destination?: PimiDestination,
  preferred?: BrowserWindow,
): Promise<void> {
  const request = ++navigationRequest;
  const owner = await options.resolveConsoleWindow(preferred);
  if (request !== navigationRequest) return;
  requestedOwner = owner;
  if (!workspace || workspace.view.webContents.isDestroyed()) {
    opening ??= createWorkspaceSurface(options).finally(() => {
      opening = undefined;
    });
    workspace = await opening;
  }
  if (request !== navigationRequest || requestedOwner !== owner || owner.isDestroyed()) return;
  workspace.owner = owner;
  attach(workspace, owner, destination && DESTINATION_SECTIONS[destination.view]);
  reveal(owner, workspace.view);
  if (destination) workspace.view.webContents.send("pimi:workspace:navigate", destination);
}

export function hidePimiWorkspace(win?: BrowserWindow): void {
  if (!win || requestedOwner === win) requestedOwner = undefined;
  const surface = workspace;
  if (!surface?.host) return;
  if (win && surface.host !== win) return;
  const host = surface.host;
  surface.releaseHost?.();
  if (!host.isDestroyed()) host.webContents.focus();
  sendLayout(surface, "hidden");
}

function reveal(win: BrowserWindow, view?: WebContentsView): void {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  (view?.webContents ?? win.webContents).focus();
}

function sendLayout(surface: WorkspaceSurface, layout: WorkspaceLayout): void {
  surface.layout = layout;
  if (!surface.view.webContents.isDestroyed())
    surface.view.webContents.send("pimi:workspace:layout", layout);
}

function closeIfUnhosted(surface: WorkspaceSurface): void {
  if (surface.host || BrowserWindow.getAllWindows().length > 0) return;
  if (!surface.view.webContents.isDestroyed()) surface.view.webContents.close();
}

function attach(
  surface: WorkspaceSurface,
  win: BrowserWindow,
  destinationSection?: PimiWorkspaceSection,
): void {
  if (surface.host === win) return;
  surface.releaseHost?.();
  surface.host = win;
  win.contentView.addChildView(surface.view);
  surface.view.webContents.send("pimi:voice:state", voiceBubbleStates.get(win) ?? VOICE_OFF);
  const sendSection = () => {
    win.webContents.send("pimi:workspace:section", surface.section);
  };
  const notifyWorkspaceClick = () => {
    if (!win.isDestroyed()) win.webContents.send("pimi:workspace:click");
  };
  if (destinationSection) {
    win.webContents.send("pimi:workspace:section", destinationSection);
  } else {
    sendSection();
  }
  win.webContents.on("did-finish-load", sendSection);
  surface.view.webContents.ipc.on("pimi:workspace:click", notifyWorkspaceClick);
  const resize = () => {
    const [width, height] = win.getContentSize();
    const top = process.platform !== "darwin" ? 38 : 0;
    const content = consoleBounds.get(win);
    const zoom = win.webContents.getZoomFactor();
    const x = Math.min(width, Math.max(0, Math.round((content?.x ?? 0) * zoom)));
    const y = Math.min(height, Math.max(top, Math.round((content?.y ?? 0) * zoom)));
    const right = content ? Math.round((content.x + content.width) * zoom) : width;
    const bottom = content ? Math.round((content.y + content.height) * zoom) : height;
    surface.view.setBounds({
      x,
      y,
      width: Math.max(0, Math.min(right, width) - x),
      height: Math.max(0, Math.min(bottom, height) - y),
    });
    const layout = content?.sidebar ? "inline" : "attached";
    if (surface.layout !== layout) sendLayout(surface, layout);
  };
  const closed = () => {
    if (surface.owner === win) surface.owner = undefined;
    surface.releaseHost?.();
    sendLayout(surface, "hidden");
    closeIfUnhosted(surface);
  };
  surface.releaseHost = () => {
    win.removeListener("resize", resize);
    win.removeListener("closed", closed);
    surface.view.webContents.ipc.removeListener("pimi:workspace:click", notifyWorkspaceClick);
    if (!win.isDestroyed()) {
      win.contentView.removeChildView(surface.view);
      win.webContents.removeListener("did-finish-load", sendSection);
      win.webContents.send("pimi:workspace:section", null);
    }
    surface.host = undefined;
    surface.releaseHost = undefined;
    surface.resizeHost = undefined;
  };
  surface.resizeHost = resize;
  win.on("resize", resize);
  win.once("closed", closed);
  resize();
}

async function createWorkspaceRuntime(runtimeDir: string): Promise<PimiRuntimeResult> {
  const entry = pathToFileURL(path.join(runtimeDir, "pimi", "server.mjs")).href;
  const { startPimi } = (await import(entry)) as PimiRuntime;
  const runtime = await startPimi({
    native: true,
    dataHome: app.getPath("userData"),
    getAppearance: getPimiAppearance,
    connection: connectToDesktopDaemon,
    onActivity: (section) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send("pimi:workspace:activity", section);
      }
    },
  });
  app.once("will-quit", () => {
    void runtime.close().catch(console.error);
  });
  return runtime;
}

export function initializePimiWorkspace(runtimeDir: string): Promise<PimiRuntimeResult> {
  workspaceRuntime ??= createWorkspaceRuntime(runtimeDir).catch((error) => {
    workspaceRuntime = undefined;
    throw error;
  });
  return workspaceRuntime;
}

async function createWorkspaceSurface(options: PimiWindowOptions): Promise<WorkspaceSurface> {
  const runtime = await initializePimiWorkspace(options.runtimeDir);
  const appearance = getPimiAppearance();
  const systemMode = nativeTheme.shouldUseDarkColors ? "dark" : "light";
  const mode = appearance === "system" ? systemMode : appearance;
  const backgroundColor = PIMI_APPEARANCE_BACKGROUNDS[mode];
  const view = new WebContentsView({
    webPreferences: {
      preload: options.workspacePreload,
      session: createPimiWorkspaceSession(runtime.origin),
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  view.setBackgroundColor(backgroundColor);
  const surface: WorkspaceSurface = {
    view,
    options,
    layout: "hidden",
    section: "memory",
    dialogOpen: false,
  };
  const contents = view.webContents;
  const cleanupUnhosted = () => {
    closeIfUnhosted(surface);
  };
  app.on("window-all-closed", cleanupUnhosted);
  contents.once("destroyed", () => {
    app.removeListener("window-all-closed", cleanupUnhosted);
    surface.releaseHost?.();
    if (workspace === surface) workspace = undefined;
  });
  contents.ipc.on("pimi:workspace:section", (event, section: unknown) => {
    if (event.senderFrame !== contents.mainFrame) return;
    if (section !== "memory" && section !== "spaces") return;
    if (section === surface.section) return;
    surface.section = section;
    surface.host?.webContents.send("pimi:workspace:section", section);
  });
  contents.ipc.on("pimi:workspace:dialog", (event, open: unknown) => {
    if (event.senderFrame === contents.mainFrame) surface.dialogOpen = open === true;
  });
  contents.ipc.on("pimi:voice:toggle", (event) => {
    if (
      event.senderFrame !== contents.mainFrame ||
      new URL(event.senderFrame.url).origin !== runtime.origin ||
      !surface.host ||
      surface.host.isDestroyed()
    )
      return;
    surface.host.webContents.send("pimi:voice:toggle");
  });
  contents.ipc.on("pimi:voice:dismiss-receipt", (event) => {
    if (
      event.senderFrame !== contents.mainFrame ||
      URL.parse(event.senderFrame.url)?.origin !== runtime.origin ||
      !surface.host ||
      surface.host.isDestroyed()
    )
      return;
    surface.host.webContents.send("pimi:voice:dismiss-receipt");
  });
  contents.on("did-finish-load", () => {
    if (surface.host) sendLayout(surface, surface.layout);
    if (surface.host) {
      contents.send("pimi:voice:state", voiceBubbleStates.get(surface.host) ?? VOICE_OFF);
    }
    contents.send("pimi:appearance:change", getPimiAppearance());
  });
  contents.ipc.on("pimi:workspace:space-link", (event, value: unknown) => {
    if (
      event.senderFrame !== contents.mainFrame ||
      URL.parse(event.senderFrame.url)?.origin !== runtime.origin ||
      surface.section !== "spaces"
    )
      return;
    const url = parsePimiSpaceUrl(value);
    if (url)
      void shell.openExternal(url.href).catch(() => {
        if (!contents.isDestroyed()) contents.send("pimi:workspace:space-link-error");
      });
  });
  contents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame) return;
    const url = URL.parse(event.url);
    const currentUrl = URL.parse(event.frame?.url ?? "");
    if (!url || !isPimiSpaceEmbed(url) || (currentUrl && isPimiArxivEmbed(currentUrl))) {
      event.preventDefault();
    }
  });
  contents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== runtime.origin) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    const agent = parseAgentDeepLink(url);
    if (url === AGENT_CONSOLE_URL) {
      hidePimiWorkspace();
      void options.resolveConsoleWindow(surface.owner).then((win) => reveal(win), console.error);
    } else if (agent) {
      hidePimiWorkspace(surface.host);
      options.openAgentChat(agent);
    } else {
      const target = new URL(url);
      if (
        target.protocol === "http:" &&
        target.hostname === "127.0.0.1" &&
        target.port &&
        !target.username &&
        !target.password
      ) {
        void shell.openExternal(target.href);
      }
    }
    return { action: "deny" };
  });
  try {
    await contents.loadURL(runtime.origin);
    return surface;
  } catch (error) {
    contents.close();
    throw error;
  }
}

/** Titlebar back closes a card open in the workspace before it leaves the section. */
export function closePimiWorkspaceDialog(): boolean {
  if (!workspace?.dialogOpen || workspace.view.webContents.isDestroyed()) return false;
  workspace.view.webContents.send("pimi:workspace:close-dialog");
  return true;
}
