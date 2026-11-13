import { canSwitchWorkbench } from "@/desktop/use-pimi-workbench";
import type { OpenInSidePanePreferences } from "@/hooks/use-settings";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { createWorkspaceFileTabTarget } from "@/workspace/file-open";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { openPreferredWorkspaceTarget } from "@/workspace-tabs/open-beside";
import { revealAnnotationSource } from "./edit-session";
import type { AnnotationCapture } from "./model";

/** The file loads and its editor mounts over several frames; a missing file never mounts one. */
const EDITOR_TIMEOUT_MS = 5000;
/** Lets the opened tab render and apply its line target before the editor is asked to go there. */
const FIRST_ATTEMPT_FRAME = 2;

export type FileRevealNotice = "unreachable" | "unsaved";

export const FILE_REVEAL_NOTICE: Record<FileRevealNotice, string> = {
  unreachable: "Could not open the annotated file",
  unsaved: "Save your changes before switching layouts.",
};

let current: (() => void) | null = null;

/**
 * Takes a file annotation back to its code: IDE Mode where the window has it, the file in the
 * editor at its lines, then the editor showing the file scrolls to the code and pulses it.
 * `onNotice` reports a layout that cannot switch or a file whose editor never appears.
 */
export function goToFileAnnotation(input: {
  attachment: AnnotationCapture;
  preferences: OpenInSidePanePreferences;
  onNotice(notice: FileRevealNotice): void;
}): void {
  const { attachment, preferences, onNotice } = input;
  const { source } = attachment;
  if (source.kind !== "file") return;
  current?.();
  const workspaceKey = buildWorkspaceTabPersistenceKey(source);
  if (!workspaceKey) {
    onNotice("unreachable");
    return;
  }
  if (canSwitchWorkbench()) {
    const result = useWorkspaceLayoutStore.getState().switchWorkbench(workspaceKey, "editor");
    if (result === "unsaved") {
      onNotice("unsaved");
      return;
    }
  }
  // The line target opens Markdown and HTML on Source, where the code was annotated.
  const tabId = openPreferredWorkspaceTarget({
    workspaceKey,
    target: createWorkspaceFileTabTarget({
      path: source.path,
      lineStart: source.startLine,
      lineEnd: source.endLine,
    }),
    source: "chatFiles",
    preferences,
  });
  if (!tabId) {
    onNotice("unreachable");
    return;
  }

  const deadline = Date.now() + EDITOR_TIMEOUT_MS;
  let frames = 0;
  let frame = 0;
  function dispose() {
    cancelAnimationFrame(frame);
    if (current === dispose) current = null;
  }
  function attempt() {
    if (++frames >= FIRST_ATTEMPT_FRAME && revealAnnotationSource(attachment)) {
      dispose();
      return;
    }
    if (Date.now() >= deadline) {
      dispose();
      onNotice("unreachable");
      return;
    }
    frame = requestAnimationFrame(attempt);
  }
  current = dispose;
  frame = requestAnimationFrame(attempt);
}
