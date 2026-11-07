// Pimi addition to the Paseo fork. Apache-2.0.
import { contextBridge, ipcRenderer } from "electron";
import type { PimiAppearance, PimiDestination, WorkspaceLayout } from "./window/pimi-window.js";

let appearance: PimiAppearance | undefined;
let onAppearanceChange: ((mode: PimiAppearance) => void) | undefined;
let layout: WorkspaceLayout = "hidden";
let onLayoutChange: ((mode: WorkspaceLayout) => void) | undefined;
ipcRenderer.on("pimi:appearance:change", (_event, mode: PimiAppearance) => {
  appearance = mode;
  onAppearanceChange?.(mode);
});
ipcRenderer.on("pimi:workspace:layout", (_event, mode: WorkspaceLayout) => {
  layout = mode;
  onLayoutChange?.(mode);
});

contextBridge.exposeInMainWorld("pimiWorkspace", {
  chrome: process.platform === "darwin" ? "mac" : "standard",
  toggleWindow: (): Promise<void> => ipcRenderer.invoke("pimi:workspace:toggle-window"),
  onLayoutChange: (apply: (mode: WorkspaceLayout) => void) => {
    onLayoutChange = apply;
    apply(layout);
  },
  onAppearanceChange: (apply: (mode: PimiAppearance) => void) => {
    onAppearanceChange = apply;
    if (appearance) apply(appearance);
  },
  onNavigate: (navigate: (destination: PimiDestination) => void) => {
    ipcRenderer.on("pimi:workspace:navigate", (_event, destination: PimiDestination) => {
      navigate(destination);
    });
  },
});
