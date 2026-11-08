// Pimi addition to the Paseo fork. Apache-2.0.
import { app, BrowserWindow, nativeTheme, shell, WebContentsView } from "electron";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readLocalCredentialForTarget, resolvePaseoHome } from "@getpaseo/server/daemon-control";
import { parseAgentDeepLink, type AgentDeepLinkTarget } from "@getpaseo/protocol/agent-deep-link";
import {
  isPimiArxivEmbed,
  isPimiSpaceEmbed,
  parsePimiSpaceUrl,
  PimiLinkedLabels,
  PimiReportLinkRequest,
  PimiReportLinkTarget,
  type PimiReportLinkError,
} from "@getpaseo/protocol/pimi-task";
import type {
  PimiDestination,
  PimiRecap,
  PimiRecapPeriod,
  PimiReviewSummary,
  PimiVoiceBubbleState,
  PimiWorkspaceSection,
} from "@getpaseo/protocol/pimi-task";
import { resolveDesktopDaemonStatus } from "../daemon/daemon-manager.js";
import { createPimiWorkspaceSession } from "./pimi-workspace-session.js";
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

const AGENT_CONSOLE_URL = "pimi-agents://open";
const APPEARANCE_FILE = "pimi-appearance.json";
export type PimiAppearance = "system" | "light" | "dark" | "paper";
export type { PimiDestination } from "@getpaseo/protocol/pimi-task";
export type WorkspaceLayout = "inline" | "attached" | "hidden";
export interface PimiContentBounds extends Electron.Rectangle {
  sidebar: boolean;
}
interface DictationAnchor {
  x: number;
  y: number;
}
interface WorkspaceSurface {
  view: WebContentsView;
  host?: BrowserWindow;
  owner?: BrowserWindow;
  releaseHost?: () => void;
  resizeHost?: () => void;
  cancelDictation?: () => void;
  options: PimiWindowOptions;
  layout: WorkspaceLayout;
  section: PimiWorkspaceSection;
  prepareChatReview: PimiRuntimeResult["prepareChatReview"];
}
let workspace: WorkspaceSurface | undefined;
let workspaceRuntime: Promise<PimiRuntimeResult> | undefined;
let onTaskComplete: ((task: { id: string; title: string }) => void | Promise<void>) | undefined;
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

export function reportPimiLinkError(win: BrowserWindow, error: PimiReportLinkError): void {
  if (workspace?.host === win && !workspace.view.webContents.isDestroyed()) {
    workspace.view.webContents.send("pimi:workspace:report-link-error", error);
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

interface PimiRuntimeResult {
  origin: string;
  observeWorkspaces(): Promise<void>;
  getLinkedLabels(): Promise<PimiLinkedLabels>;
  getRecap(period: PimiRecapPeriod): PimiRecap;
  subscribeToLabels(listener: () => void): () => void;
  resolveReportLink(request: PimiReportLinkRequest): Promise<PimiReportLinkTarget>;
  prepareChatReview(
    path: string,
    serverId?: string,
  ): Promise<{
    path: string;
    reviewNotice?: string;
    reviewTarget?: { path: string; repo: string; name: string; branch: string };
  }>;
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
    paths: string[];
    watchState: string;
    taskState: string;
    agentTaskHome?: string;
    getAppearance: () => PimiAppearance;
    openDictation: (signal: AbortSignal, anchor?: DictationAnchor) => Promise<string | null>;
    listEditors: (
      workspacePath: string,
    ) => Promise<Pick<EditorTargetDescriptor, "id" | "label" | "kind">[]>;
    launchEditor: (input: EditorTargetLaunchInput & { editorId: string }) => Promise<void>;
    connection: () => Promise<DesktopDaemonConnection>;
    onTaskComplete: (task: { id: string; title: string }) => void | Promise<void>;
  }): Promise<PimiRuntimeResult>;
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
  localDataCredential?: string;
}

async function connectToDesktopDaemon(): Promise<DesktopDaemonConnection> {
  if (process.env.PIMI_PASEO_URL) return { url: process.env.PIMI_PASEO_URL };
  const status = await resolveDesktopDaemonStatus();
  const endpoint = status.listen ?? process.env.PASEO_LISTEN ?? "127.0.0.1:6767";
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
  const navigation =
    destination?.view === "review"
      ? {
          ...destination,
          ...(await workspace.prepareChatReview(destination.path, destination.serverId)),
        }
      : destination;
  if (request !== navigationRequest || requestedOwner !== owner || owner.isDestroyed()) return;
  workspace.owner = owner;
  attach(workspace, owner);
  reveal(owner, workspace.view);
  if (navigation) workspace.view.webContents.send("pimi:workspace:navigate", navigation);
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

function attach(surface: WorkspaceSurface, win: BrowserWindow): void {
  if (surface.host === win) return;
  surface.releaseHost?.();
  surface.host = win;
  win.contentView.addChildView(surface.view);
  surface.view.webContents.send("pimi:voice:state", voiceBubbleStates.get(win) ?? VOICE_OFF);
  const sendSection = () => win.webContents.send("pimi:workspace:section", surface.section);
  const notifyWorkspaceClick = () => {
    if (!win.isDestroyed()) win.webContents.send("pimi:workspace:click");
  };
  sendSection();
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
    surface.cancelDictation?.();
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
  const editors = createEditorTargetRuntime();
  const runtime = await startPimi({
    native: true,
    watchState: path.join(app.getPath("userData"), "pimi-worktrees.json"),
    taskState: path.join(app.getPath("userData"), "pimi-tasks.json"),
    agentTaskHome: resolvePaseoHome(),
    getAppearance: getPimiAppearance,
    openDictation: (signal, anchor) => {
      if (!workspace?.host) return Promise.reject(new Error("Open the workspace to dictate."));
      return dictateBrief(workspace, workspace.host, signal, anchor);
    },
    listEditors: async (workspacePath) =>
      (
        await listAvailableEditorTargets(editors, PIMI_EDITOR_TARGETS, {
          workspacePath,
        })
      ).map(({ id, label, kind }) => ({ id, label, kind })),
    launchEditor: (input) => openEditorTarget(input, editors, PIMI_EDITOR_TARGETS),
    paths: process.env.PIMI_REPOS?.split(path.delimiter).filter(Boolean) ?? [],
    connection: connectToDesktopDaemon,
    onTaskComplete: (task) => onTaskComplete?.(task),
  });
  const unsubscribeLabels = runtime.subscribeToLabels(() => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send("pimi:labels:changed");
    }
  });
  app.once("will-quit", () => {
    unsubscribeLabels();
    void runtime.close().catch(console.error);
  });
  return runtime;
}

export function initializePimiWorkspace(
  runtimeDir: string,
  notifyTaskCompletion?: typeof onTaskComplete,
): Promise<PimiRuntimeResult> {
  if (notifyTaskCompletion) onTaskComplete = notifyTaskCompletion;
  workspaceRuntime ??= createWorkspaceRuntime(runtimeDir).catch((error) => {
    workspaceRuntime = undefined;
    throw error;
  });
  return workspaceRuntime;
}

async function createWorkspaceSurface(options: PimiWindowOptions): Promise<WorkspaceSurface> {
  const runtime = await initializePimiWorkspace(options.runtimeDir);
  const appearance = getPimiAppearance();
  let backgroundColor = "#faf7f6";
  if (appearance === "paper") backgroundColor = "#f7f2e8";
  if (appearance === "dark" || (appearance === "system" && nativeTheme.shouldUseDarkColors)) {
    backgroundColor = "#232224";
  }
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
    section: "tasks",
    prepareChatReview: runtime.prepareChatReview,
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
    if (
      section !== "tasks" &&
      section !== "board" &&
      section !== "review" &&
      section !== "memory" &&
      section !== "spaces"
    ) {
      return;
    }
    if (section === surface.section) return;
    surface.section = section;
    surface.host?.webContents.send("pimi:workspace:section", section);
  });
  contents.ipc.on("pimi:voice:toggle", (event) => {
    if (
      event.senderFrame !== contents.mainFrame ||
      new URL(event.senderFrame.url).origin !== runtime.origin ||
      !surface.host ||
      surface.host.isDestroyed() ||
      surface.cancelDictation
    )
      return;
    surface.host.webContents.send("pimi:voice:toggle");
  });
  contents.on("did-finish-load", () => {
    if (surface.host) sendLayout(surface, surface.layout);
    if (surface.host) {
      contents.send("pimi:voice:state", voiceBubbleStates.get(surface.host) ?? VOICE_OFF);
    }
    contents.send("pimi:appearance:change", getPimiAppearance());
  });
  contents.ipc.on("pimi:workspace:report-link", (event, value: unknown) => {
    if (
      event.senderFrame !== contents.mainFrame ||
      URL.parse(event.senderFrame.url)?.origin !== runtime.origin ||
      surface.section !== "tasks"
    )
      return;
    const request = PimiReportLinkRequest.safeParse(value);
    if (!request.success) return;
    const agent = parseAgentDeepLink(request.data.href);
    if (agent) {
      hidePimiWorkspace(surface.host);
      options.openAgentChat(agent);
      return;
    }
    const host = surface.host;
    const fail = (message: string) => {
      if (!contents.isDestroyed()) {
        contents.send("pimi:workspace:report-link-error", {
          reportId: request.data.reportId,
          message,
        });
      }
    };
    if (!host || host.isDestroyed()) {
      fail("Open Pimi's Agent Console to view this link.");
      return;
    }
    void (async () => {
      try {
        const target = PimiReportLinkTarget.parse(await runtime.resolveReportLink(request.data));
        if (host.isDestroyed() || surface.host !== host) return;
        host.webContents.send("pimi:workspace:open-report-link", target);
      } catch (error) {
        console.error("Could not open report link:", error);
        fail("This report's workspace is unavailable. Reconnect its host and try again.");
      }
    })();
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

function dictateBrief(
  surface: WorkspaceSurface,
  host: BrowserWindow,
  signal: AbortSignal,
  anchor?: DictationAnchor,
): Promise<string | null> {
  if (host.isDestroyed() || signal.aborted) return Promise.resolve(null);
  if (surface.cancelDictation) {
    return Promise.reject(new Error("A dictation is already open."));
  }
  host.webContents.send("pimi:voice:pause");

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
    const area = surface.view.getBounds();
    const zoom = surface.view.webContents.getZoomFactor();
    const islandWidth = Math.min(304, area.width);
    const islandHeight = Math.min(80, area.height);
    const center = anchor ? anchor.x * zoom : area.width / 2;
    const bottom = anchor ? anchor.y * zoom : area.height / 2;
    island.setBounds({
      x:
        area.x +
        Math.max(0, Math.min(area.width - islandWidth, Math.round(center - islandWidth / 2))),
      y:
        area.y +
        Math.max(0, Math.min(area.height - islandHeight, Math.round(bottom - islandHeight / 2))),
      width: islandWidth,
      height: islandHeight,
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
