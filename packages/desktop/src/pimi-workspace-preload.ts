// Pimi addition to the Paseo fork. Apache-2.0.
import { contextBridge, ipcRenderer } from "electron";
import type { PimiAppearance, PimiDestination, WorkspaceLayout } from "./window/pimi-window.js";
import type { PimiVoiceBubbleState, PimiWorkspaceSection } from "@pimi/protocol/pimi-task";

let appearance: PimiAppearance | undefined;
let onAppearanceChange: ((mode: PimiAppearance) => void) | undefined;
let layout: WorkspaceLayout = "hidden";
let onLayoutChange: ((mode: WorkspaceLayout) => void) | undefined;
let voiceState: PimiVoiceBubbleState = { visible: false, active: false, status: "", level: 0 };
let onVoiceState: ((state: PimiVoiceBubbleState) => void) | undefined;
ipcRenderer.on("pimi:voice:state", (_event, state: PimiVoiceBubbleState) => {
  voiceState = state;
  onVoiceState?.(state);
});
ipcRenderer.on("pimi:appearance:change", (_event, mode: PimiAppearance) => {
  appearance = mode;
  onAppearanceChange?.(mode);
});
ipcRenderer.on("pimi:workspace:layout", (_event, mode: WorkspaceLayout) => {
  layout = mode;
  onLayoutChange?.(mode);
});
window.addEventListener(
  "click",
  (event) => {
    if (!event.isTrusted) return;
    ipcRenderer.send("pimi:workspace:click");
    if (event.target instanceof Element && event.target.closest("#pimi-voice-toggle")) {
      ipcRenderer.send("pimi:voice:toggle");
    }
    const spaceLink =
      event.target instanceof Element ? event.target.closest("button[data-space-url]") : null;
    if (spaceLink)
      ipcRenderer.send("pimi:workspace:space-link", spaceLink.getAttribute("data-space-url"));
    const link =
      event.target instanceof Element
        ? event.target.closest<HTMLAnchorElement>("a[data-pimi-report-link]")
        : null;
    if (link) {
      event.preventDefault();
      const report = link.closest<HTMLElement>("#task-report-document");
      ipcRenderer.send("pimi:workspace:report-link", {
        taskId: report?.dataset.taskId,
        reportId: report?.dataset.reportId,
        href: link.getAttribute("href"),
      });
    }
  },
  true,
);

contextBridge.exposeInMainWorld("pimiWorkspace", {
  chrome: process.platform === "darwin" ? "mac" : "standard",
  setSection: (section: PimiWorkspaceSection) =>
    ipcRenderer.send("pimi:workspace:section", section),
  setReviewLocation: (
    location: { view: "review-pr"; url: string } | { view: "review-prs" } | { view: "review-home" },
  ) => ipcRenderer.send("pimi:workspace:review-location", location),
  onLayoutChange: (apply: (mode: WorkspaceLayout) => void) => {
    onLayoutChange = apply;
    apply(layout);
  },
  onAppearanceChange: (apply: (mode: PimiAppearance) => void) => {
    onAppearanceChange = apply;
    if (appearance) apply(appearance);
  },
  onReportLinkError: (listener: (error: { reportId: string; message: string }) => void) => {
    ipcRenderer.on("pimi:workspace:report-link-error", (_event, error) => listener(error));
  },
  onSpaceLinkError: (listener: () => void) => {
    ipcRenderer.on("pimi:workspace:space-link-error", () => listener());
  },
  onPaperUnavailable: (listener: (url: string) => void) => {
    ipcRenderer.on("pimi:workspace:paper-unavailable", (_event, url: string) => listener(url));
  },
  onNavigate: (navigate: (destination: PimiDestination) => void) => {
    ipcRenderer.on("pimi:workspace:navigate", (_event, destination: PimiDestination) => {
      navigate(destination);
    });
  },
  onVoiceState: (apply: (state: PimiVoiceBubbleState) => void) => {
    onVoiceState = apply;
    apply(voiceState);
  },
});
