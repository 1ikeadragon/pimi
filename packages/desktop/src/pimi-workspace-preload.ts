// Pimi addition to the Paseo fork. Apache-2.0.
import { contextBridge, ipcRenderer } from "electron";
import type { PimiAppearance, PimiDestination } from "./window/pimi-window.js";

let appearance: PimiAppearance | undefined;
let onAppearanceChange: ((mode: PimiAppearance) => void) | undefined;
ipcRenderer.on("pimi:appearance:change", (_event, mode: PimiAppearance) => {
  appearance = mode;
  onAppearanceChange?.(mode);
});

contextBridge.exposeInMainWorld("pimiWorkspace", {
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
