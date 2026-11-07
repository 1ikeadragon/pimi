// Pimi addition to the Paseo fork. Apache-2.0.
import { app, BrowserWindow, ipcMain, nativeTheme, shell } from "electron";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readLocalCredentialForTarget } from "@getpaseo/server/daemon-control";
import { parseAgentDeepLink, type AgentDeepLinkTarget } from "@getpaseo/protocol/agent-deep-link";
import type { PimiDestination } from "@getpaseo/protocol/pimi-task";
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

const AGENT_CONSOLE_URL = "pimi-agents://open";
const SETTINGS_URL = "pimi-settings://open";
const APPEARANCE_FILE = "pimi-appearance.json";
export type PimiAppearance = "system" | "light" | "dark" | "paper";
export type { PimiDestination } from "@getpaseo/protocol/pimi-task";
let currentWindow: BrowserWindow | undefined;
let dictationWindow: BrowserWindow | undefined;
let opening: Promise<void> | undefined;
let appearanceWrites: Promise<void> = Promise.resolve();

export function isPimiWindow(win: BrowserWindow): boolean {
  return win === currentWindow || win === dictationWindow;
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
    openDictation: () => Promise<string | null>;
    listEditors: (
      workspacePath: string,
    ) => Promise<Pick<EditorTargetDescriptor, "id" | "label" | "kind">[]>;
    launchEditor: (input: EditorTargetLaunchInput & { editorId: string }) => Promise<void>;
    connection: () => Promise<{ url: string; credential?: string }>;
  }): Promise<{ origin: string; appearance: string; close(): Promise<void> }>;
}

interface PimiWindowOptions {
  runtimeDir: string;
  openAgentConsole: () => void;
  openSettings: () => void;
  openAgentChat: (target: AgentDeepLinkTarget) => void;
  dictationUrl: string;
  preload: string;
  workspacePreload: string;
}

async function connectToDesktopDaemon(): Promise<{ url: string; credential?: string }> {
  if (process.env.PIMI_PASEO_URL) return { url: process.env.PIMI_PASEO_URL };
  const status = await resolveDesktopDaemonStatus();
  const endpoint = status.listen ?? process.env.PASEO_LISTEN ?? "127.0.0.1:6767";
  const credential = status.desktopManaged
    ? (readLocalCredentialForTarget(status.home, endpoint) ?? undefined)
    : undefined;
  return { url: `ws://${endpoint}/ws`, credential };
}

export async function showPimiWindow(
  options: PimiWindowOptions,
  destination?: PimiDestination,
): Promise<void> {
  if (opening) await opening;
  if (!currentWindow || currentWindow.isDestroyed()) {
    opening = createPimiWindow(options).finally(() => {
      opening = undefined;
    });
    await opening;
  }
  if (currentWindow && !currentWindow.isDestroyed()) {
    if (currentWindow.isMinimized()) currentWindow.restore();
    currentWindow.show();
    currentWindow.focus();
    if (destination) currentWindow.webContents.send("pimi:workspace:navigate", destination);
  }
}

async function createPimiWindow(options: PimiWindowOptions): Promise<void> {
  const entry = pathToFileURL(path.join(options.runtimeDir, "pimi", "server.mjs")).href;
  const { startPimi } = (await import(entry)) as PimiRuntime;
  const editors = createEditorTargetRuntime();
  const runtime = await startPimi({
    native: true,
    watchState: path.join(app.getPath("userData"), "pimi-worktrees.json"),
    taskState: path.join(app.getPath("userData"), "pimi-tasks.json"),
    getAppearance: getPimiAppearance,
    openDictation: () => dictateBrief(window, options),
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
  const window = new BrowserWindow({
    title: "Pimi",
    width: 1320,
    height: 850,
    minWidth: 700,
    minHeight: 520,
    show: false,
    backgroundColor,
    webPreferences: {
      preload: options.workspacePreload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  currentWindow = window;
  window.once("closed", () => {
    if (currentWindow === window) currentWindow = undefined;
    void runtime.close();
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== runtime.origin) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    const agent = parseAgentDeepLink(url);
    if (url === AGENT_CONSOLE_URL) {
      options.openAgentConsole();
    } else if (url === SETTINGS_URL) {
      options.openSettings();
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
    await window.loadURL(runtime.origin);
    window.show();
    window.focus();
  } catch (error) {
    window.destroy();
    throw error;
  }
}

function dictateBrief(parent: BrowserWindow, options: PimiWindowOptions): Promise<string | null> {
  if (parent.isDestroyed()) return Promise.resolve(null);
  if (dictationWindow && !dictationWindow.isDestroyed()) {
    return Promise.reject(new Error("A dictation is already open."));
  }
  const child = new BrowserWindow({
    parent,
    modal: true,
    title: "Dictate brief",
    width: 430,
    height: 245,
    resizable: false,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#181a19" : "#fffdfd",
    webPreferences: {
      preload: options.preload,
      additionalArguments: ["--pimi-task-dictation", pimiAppearanceArgument()],
      autoplayPolicy: "no-user-gesture-required",
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  dictationWindow = child;
  child.webContents.on("will-navigate", (event) => event.preventDefault());
  child.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  child.once("ready-to-show", () => child.show());

  return new Promise((resolve, reject) => {
    const channel = "pimi:task-dictation:complete";
    const complete = (event: Electron.IpcMainEvent, value: unknown) => {
      if (
        event.sender !== child.webContents ||
        event.senderFrame !== child.webContents.mainFrame ||
        event.senderFrame.url !== options.dictationUrl
      )
        return;
      if (value !== null && typeof value !== "string") return;
      if (typeof value === "string" && value.length > 2400) {
        reject(new Error("The transcript is too long for a task brief. Try a shorter recording."));
      } else {
        resolve(value);
      }
      child.destroy();
    };
    ipcMain.on(channel, complete);
    child.once("closed", () => {
      ipcMain.removeListener(channel, complete);
      if (dictationWindow === child) dictationWindow = undefined;
      resolve(null);
    });
    void child.loadURL(options.dictationUrl).catch((error: Error) => {
      reject(error);
      if (!child.isDestroyed()) child.destroy();
    });
  });
}
