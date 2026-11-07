// Pimi addition to the Paseo fork. Apache-2.0.
import { app, BrowserWindow, nativeTheme, shell, WebContentsView } from "electron";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readLocalCredentialForTarget } from "@getpaseo/server/daemon-control";
import { parseAgentDeepLink, type AgentDeepLinkTarget } from "@getpaseo/protocol/agent-deep-link";
import type { PimiDestination, PimiWorkspaceSection } from "@getpaseo/protocol/pimi-task";
import { resolveDesktopDaemonStatus } from "../daemon/daemon-manager.js";
import {
  listAvailableEditorTargets,
  openEditorTarget,
  PIMI_EDITOR_TARGETS,
} from "../features/editor-targets/registry.js";
import { createEditorTargetRuntime } from "../features/editor-targets/runtime.js";
import type {
  EditorTargetDescriptor,
  EditorTargetLaunchInput,
} from "../features/editor-targets/target.js";
import { getMainWindowChromeOptions } from "./window-manager.js";

const AGENT_CONSOLE_URL = "pimi-agents://open";
const APPEARANCE_FILE = "pimi-appearance.json";
export type PimiAppearance = "system" | "light" | "dark" | "paper";
export type { PimiDestination } from "@getpaseo/protocol/pimi-task";
export type WorkspaceLayout = "inline" | "attached" | "detached" | "hidden";
export interface PimiContentBounds extends Electron.Rectangle {
  sidebar: boolean;
}
interface WorkspaceSurface {
  view: WebContentsView;
  host?: BrowserWindow;
  owner?: BrowserWindow;
  detached?: BrowserWindow;
  releaseHost?: () => void;
  resizeHost?: () => void;
  cancelDictation?: () => void;
  options: PimiWindowOptions;
  backgroundColor: string;
  layout: WorkspaceLayout;
  section: PimiWorkspaceSection;
}
let workspace: WorkspaceSurface | undefined;
let opening: Promise<WorkspaceSurface> | undefined;
let requestedOwner: BrowserWindow | undefined;
let appearanceWrites: Promise<void> = Promise.resolve();
const consoleBounds = new WeakMap<BrowserWindow, PimiContentBounds>();

export function updatePimiContentBounds(win: BrowserWindow, bounds: PimiContentBounds): void {
  consoleBounds.set(win, bounds);
  if (workspace?.host === win) workspace.resizeHost?.();
}

export function isPimiWindow(win: BrowserWindow): boolean {
  return win === workspace?.detached;
}

function getPimiAppearance(): PimiAppearance {
  try {
    const value: unknown = JSON.parse(
      readFileSync(path.join(app.getPath("userData"), APPEARANCE_FILE), "utf8"),
    );
    if (value === "light" || value === "dark" || value === "paper") return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("Could not read Pimi appearance:", error);
    }
  }
  return "system";
}

export async function setPimiAppearance(mode: unknown): Promise<void> {
  if (mode !== "system" && mode !== "light" && mode !== "dark" && mode !== "paper") {
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

interface PimiRuntime {
  startPimi(options: {
    native: boolean;
    paths: string[];
    watchState: string;
    taskState: string;
    getAppearance: () => PimiAppearance;
    openDictation: (signal: AbortSignal) => Promise<string | null>;
    listEditors: (
      workspacePath: string,
    ) => Promise<Pick<EditorTargetDescriptor, "id" | "label" | "kind">[]>;
    launchEditor: (input: EditorTargetLaunchInput & { editorId: string }) => Promise<void>;
    connection: () => Promise<DesktopDaemonConnection>;
  }): Promise<{ origin: string; appearance: string; close(): Promise<void> }>;
}

interface PimiWindowOptions {
  runtimeDir: string;
  resolveConsoleWindow: (preferred?: BrowserWindow) => Promise<BrowserWindow>;
  openAgentChat: (target: AgentDeepLinkTarget) => void;
  dictationUrl: string;
  preload: string;
  workspacePreload: string;
}

interface DesktopDaemonConnection {
  url: string;
  credential?: string;
  memoryCredential?: string;
}

async function connectToDesktopDaemon(): Promise<DesktopDaemonConnection> {
  if (process.env.PIMI_PASEO_URL) return { url: process.env.PIMI_PASEO_URL };
  const status = await resolveDesktopDaemonStatus();
  const endpoint = status.listen ?? process.env.PASEO_LISTEN ?? "127.0.0.1:6767";
  const local = readLocalCredentialForTarget(status.home, endpoint) ?? undefined;
  return {
    url: `ws://${endpoint}/ws`,
    credential: status.desktopManaged ? local : undefined,
    memoryCredential: local,
  };
}

export async function showPimiWindow(
  options: PimiWindowOptions,
  destination?: PimiDestination,
  preferred?: BrowserWindow,
): Promise<void> {
  const owner = await options.resolveConsoleWindow(preferred);
  requestedOwner = owner;
  if (!workspace || workspace.view.webContents.isDestroyed()) {
    opening ??= createWorkspaceSurface(options).finally(() => {
      opening = undefined;
    });
    workspace = await opening;
  }
  if (requestedOwner !== owner || owner.isDestroyed()) return;
  workspace.owner = owner;
  const host = workspace.detached ?? owner;
  attach(workspace, host);
  reveal(host, workspace.view);
  if (destination) workspace.view.webContents.send("pimi:workspace:navigate", destination);
}

export function hidePimiWorkspace(win?: BrowserWindow): void {
  if (!win || requestedOwner === win) requestedOwner = undefined;
  const surface = workspace;
  if (!surface || !surface.host || surface.host === surface.detached) return;
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
  if (surface.host || BrowserWindow.getAllWindows().some((win) => !isPimiWindow(win))) return;
  if (!surface.view.webContents.isDestroyed()) surface.view.webContents.close();
}

function attach(surface: WorkspaceSurface, win: BrowserWindow): void {
  if (surface.host === win) return;
  surface.releaseHost?.();
  surface.host = win;
  win.contentView.addChildView(surface.view);
  const attached = win !== surface.detached;
  const defaultLayout = attached ? "attached" : "detached";
  const sendSection = () => win.webContents.send("pimi:workspace:section", surface.section);
  if (attached) {
    sendSection();
    win.webContents.on("did-finish-load", sendSection);
  }
  const resize = () => {
    const [width, height] = win.getContentSize();
    const top = process.platform !== "darwin" && attached ? 38 : 0;
    const content = attached ? consoleBounds.get(win) : undefined;
    const zoom = attached ? win.webContents.getZoomFactor() : 1;
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
    const layout = content?.sidebar ? "inline" : defaultLayout;
    if (surface.layout !== layout) sendLayout(surface, layout);
  };
  const closed = () => {
    if (surface.detached === win) surface.detached = undefined;
    if (surface.owner === win) surface.owner = undefined;
    surface.releaseHost?.();
    sendLayout(surface, "hidden");
    closeIfUnhosted(surface);
  };
  surface.releaseHost = () => {
    surface.cancelDictation?.();
    win.removeListener("resize", resize);
    win.removeListener("closed", closed);
    if (!win.isDestroyed()) {
      win.contentView.removeChildView(surface.view);
      if (attached) {
        win.webContents.removeListener("did-finish-load", sendSection);
        win.webContents.send("pimi:workspace:section", null);
      }
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

async function toggleWorkspaceWindow(surface: WorkspaceSurface): Promise<void> {
  if (surface.detached) {
    const detached = surface.detached;
    const owner = await surface.options.resolveConsoleWindow(surface.owner);
    surface.owner = owner;
    surface.detached = undefined;
    attach(surface, owner);
    if (!detached.isDestroyed()) detached.destroy();
    reveal(owner, surface.view);
    return;
  }
  const win = new BrowserWindow({
    ...(process.platform === "darwin" ? getMainWindowChromeOptions({ mode: "native-mac" }) : {}),
    title: "Pimi Workspace",
    width: 1320,
    height: 850,
    minWidth: 700,
    minHeight: 520,
    show: false,
    backgroundColor: surface.backgroundColor,
  });
  surface.detached = win;
  attach(surface, win);
  reveal(win, surface.view);
}

async function createWorkspaceSurface(options: PimiWindowOptions): Promise<WorkspaceSurface> {
  const entry = pathToFileURL(path.join(options.runtimeDir, "pimi", "server.mjs")).href;
  const { startPimi } = (await import(entry)) as PimiRuntime;
  const editors = createEditorTargetRuntime();
  let surface: WorkspaceSurface | undefined;
  const runtime = await startPimi({
    native: true,
    watchState: path.join(app.getPath("userData"), "pimi-worktrees.json"),
    taskState: path.join(app.getPath("userData"), "pimi-tasks.json"),
    getAppearance: getPimiAppearance,
    openDictation: (signal) => {
      if (!surface?.host) return Promise.reject(new Error("Open the workspace to dictate."));
      return dictateBrief(surface, surface.host, signal);
    },
    listEditors: async (workspacePath) =>
      (await listAvailableEditorTargets(editors, PIMI_EDITOR_TARGETS, { workspacePath })).map(
        ({ id, label, kind }) => ({ id, label, kind }),
      ),
    launchEditor: (input) => openEditorTarget(input, editors, PIMI_EDITOR_TARGETS),
    paths: process.env.PIMI_REPOS?.split(path.delimiter).filter(Boolean) ?? [],
    connection: connectToDesktopDaemon,
  });
  let backgroundColor = "#faf7f6";
  if (runtime.appearance === "paper") backgroundColor = "#f7f2e8";
  if (
    runtime.appearance === "dark" ||
    (runtime.appearance === "system" && nativeTheme.shouldUseDarkColors)
  ) {
    backgroundColor = "#1a191b";
  }
  const view = new WebContentsView({
    webPreferences: {
      preload: options.workspacePreload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  view.setBackgroundColor(backgroundColor);
  surface = { view, options, backgroundColor, layout: "hidden", section: "tasks" };
  const contents = view.webContents;
  const cleanupUnhosted = () => {
    if (surface) closeIfUnhosted(surface);
  };
  app.on("window-all-closed", cleanupUnhosted);
  contents.once("destroyed", () => {
    app.removeListener("window-all-closed", cleanupUnhosted);
    surface?.releaseHost?.();
    if (workspace === surface) workspace = undefined;
    void runtime.close();
  });
  contents.ipc.handle("pimi:workspace:toggle-window", (event) => {
    if (event.senderFrame !== contents.mainFrame || !surface?.host) return undefined;
    return toggleWorkspaceWindow(surface);
  });
  contents.ipc.on("pimi:workspace:section", (event, section: unknown) => {
    if (event.senderFrame !== contents.mainFrame || !surface) return;
    if (
      section !== "tasks" &&
      section !== "board" &&
      section !== "review" &&
      section !== "memory"
    ) {
      return;
    }
    if (section === surface.section) return;
    surface.section = section;
    if (surface.host && surface.host !== surface.detached) {
      surface.host.webContents.send("pimi:workspace:section", section);
    }
  });
  contents.on("did-finish-load", () => {
    if (surface?.host) sendLayout(surface, surface.layout);
    contents.send("pimi:appearance:change", getPimiAppearance());
  });
  contents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== runtime.origin) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    const agent = parseAgentDeepLink(url);
    if (url === AGENT_CONSOLE_URL) {
      hidePimiWorkspace();
      void options.resolveConsoleWindow(surface?.owner).then((win) => reveal(win), console.error);
    } else if (agent) {
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

function dictateBrief(
  surface: WorkspaceSurface,
  host: BrowserWindow,
  signal: AbortSignal,
): Promise<string | null> {
  if (host.isDestroyed() || signal.aborted) return Promise.resolve(null);
  if (surface.cancelDictation) {
    return Promise.reject(new Error("A dictation is already open."));
  }

  const { dictationUrl, preload } = surface.options;
  const island = new WebContentsView({
    webPreferences: {
      preload,
      additionalArguments: ["--pimi-task-dictation", pimiAppearanceArgument()],
      autoplayPolicy: "no-user-gesture-required",
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const contents = island.webContents;
  island.setBackgroundColor("#00000000");
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));

  const resize = () => {
    const [width, height] = host.getContentSize();
    const islandWidth = Math.min(460, width);
    island.setBounds({
      x: Math.round((width - islandWidth) / 2),
      y: Math.max(0, height - 144),
      width: islandWidth,
      height: 144,
    });
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value: string | null, error?: Error) => {
      if (settled) return;
      settled = true;
      surface.cancelDictation = undefined;
      signal.removeEventListener("abort", cancel);
      host.removeListener("resize", resize);
      if (!host.isDestroyed()) {
        host.contentView.removeChildView(island);
        if (!surface.view.webContents.isDestroyed()) surface.view.webContents.focus();
      }
      if (!contents.isDestroyed()) contents.close();
      if (error) reject(error);
      else resolve(value);
    };
    const cancel = () => finish(null);
    surface.cancelDictation = cancel;
    signal.addEventListener("abort", cancel, { once: true });
    contents.once("destroyed", cancel);
    contents.on("render-process-gone", () =>
      finish(null, new Error("Dictation closed unexpectedly. Try again.")),
    );
    contents.ipc.on("pimi:task-dictation:complete", (event, value: unknown) => {
      if (event.senderFrame !== contents.mainFrame || event.senderFrame.url !== dictationUrl)
        return;
      if (value !== null && typeof value !== "string") return;
      if (typeof value === "string" && value.length > 2400) {
        finish(
          null,
          new Error("The transcript is too long for a task brief. Try a shorter recording."),
        );
      } else {
        finish(value);
      }
    });
    void contents.loadURL(dictationUrl).then(
      () => {
        if (settled || host.isDestroyed()) return cancel();
        resize();
        host.contentView.addChildView(island);
        host.on("resize", resize);
        contents.focus();
        return undefined;
      },
      (error: Error) => finish(null, error),
    );
  });
}
