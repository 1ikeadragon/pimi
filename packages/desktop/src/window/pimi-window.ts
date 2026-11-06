// Pimi addition to the Paseo fork. Apache-2.0.
import { app, BrowserWindow, shell } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readLocalCredentialForTarget } from "@getpaseo/server/daemon-control";
import { resolveDesktopDaemonStatus } from "../daemon/daemon-manager.js";
import { openEditorTarget } from "../features/editor-targets/registry.js";
import { createEditorTargetRuntime } from "../features/editor-targets/runtime.js";
import type { EditorTargetLaunchInput } from "../features/editor-targets/target.js";

const AGENT_CONSOLE_URL = "pimi-agents://open";
let currentWindow: BrowserWindow | undefined;
let opening: Promise<void> | undefined;

export function isPimiWindow(win: BrowserWindow): boolean {
  return win === currentWindow;
}

interface PimiRuntime {
  startPimi(options: {
    native: boolean;
    paths: string[];
    watchState: string;
    launchEditor: (input: EditorTargetLaunchInput) => Promise<void>;
    connection: () => Promise<{ url: string; credential?: string }>;
  }): Promise<{ origin: string; close(): Promise<void> }>;
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

export async function showPimiWindow(options: {
  runtimeDir: string;
  openAgentConsole: () => void;
}): Promise<void> {
  if (currentWindow && !currentWindow.isDestroyed()) {
    if (currentWindow.isMinimized()) currentWindow.restore();
    currentWindow.show();
    currentWindow.focus();
    return;
  }
  opening ??= createPimiWindow(options).finally(() => {
    opening = undefined;
  });
  return opening;
}

async function createPimiWindow(options: {
  runtimeDir: string;
  openAgentConsole: () => void;
}): Promise<void> {
  const entry = pathToFileURL(path.join(options.runtimeDir, "pimi", "server.mjs")).href;
  const { startPimi } = (await import(entry)) as PimiRuntime;
  const runtime = await startPimi({
    native: true,
    watchState: path.join(app.getPath("userData"), "pimi-worktrees.json"),
    launchEditor: (input) =>
      openEditorTarget({ ...input, editorId: "zed" }, createEditorTargetRuntime()),
    paths: process.env.PIMI_REPOS?.split(path.delimiter).filter(Boolean) ?? [],
    connection: connectToDesktopDaemon,
  });
  const window = new BrowserWindow({
    title: "Pimi",
    width: 1320,
    height: 850,
    minWidth: 700,
    minHeight: 520,
    show: false,
    backgroundColor: "#12141a",
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
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
    if (url === AGENT_CONSOLE_URL) {
      options.openAgentConsole();
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
