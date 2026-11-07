// Pimi addition to the Paseo fork. Apache-2.0.
import { contextBridge, ipcRenderer } from "electron";
import type { PimiDestination } from "./window/pimi-window.js";

contextBridge.exposeInMainWorld("pimiWorkspace", {
  onNavigate: (navigate: (destination: PimiDestination) => void) => {
    ipcRenderer.on("pimi:workspace:navigate", (_event, destination: PimiDestination) => {
      navigate(destination);
    });
  },
});
