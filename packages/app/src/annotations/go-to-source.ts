import type { OpenInSidePanePreferences } from "@/hooks/use-settings";
import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { revealWorkspaceTab } from "@/workspace-tabs/navigation";
import { revealAnnotationSource } from "./edit-session";
import { FILE_REVEAL_NOTICE, goToFileAnnotation } from "./file-reveal";
import type { AnnotationCapture } from "./model";

/** The chat's tab is revealed and its list loads over several frames before the quote is found. */
const CHAT_TIMEOUT_MS = 5000;
const CHAT_UNREACHABLE_NOTICE = "Could not open the annotated chat";

interface GoToSourceInput {
  preferences: OpenInSidePanePreferences;
  /** A message for the user: the source cannot be reached from here. */
  onNotice(message: string): void;
}

/**
 * Takes an annotation back to what it quotes. A file annotation opens the file at its lines. A
 * chat annotation scrolls an open chat to the quote. Returns false when no open chat can show
 * that quote, and nothing has moved, so the caller can fall back.
 */
export function goToAnnotationSource(
  attachment: AnnotationCapture,
  input: GoToSourceInput,
): boolean {
  if (attachment.source.kind === "file") {
    goToFileAnnotation({
      attachment,
      preferences: input.preferences,
      onNotice: (notice) => input.onNotice(FILE_REVEAL_NOTICE[notice]),
    });
    return true;
  }
  return revealAnnotationSource(attachment);
}

let cancelPendingChat: (() => void) | null = null;

function findChatTab(source: Extract<AnnotationCapture["source"], { kind: "chat" }>) {
  const { layoutByWorkspace } = useWorkspaceLayoutStore.getState();
  for (const [workspaceKey, layout] of Object.entries(layoutByWorkspace)) {
    if (!workspaceKey.startsWith(`${source.serverId}:`)) continue;
    const tab = collectAllTabs(layout.root).find(
      (candidate) =>
        candidate.target.kind === "agent" && candidate.target.agentId === source.agentId,
    );
    if (tab) return { workspaceKey, tabId: tab.tabId };
  }
  return null;
}

/**
 * Like `goToAnnotationSource` for a pill with no note editor to fall back to, as on a sent
 * message: a chat quote whose chat is open in a hidden tab has the tab shown first. Chat
 * history this window never loaded cannot be reached, and says so.
 */
export function goToSentAnnotationSource(
  attachment: AnnotationCapture,
  input: GoToSourceInput,
): void {
  cancelPendingChat?.();
  cancelPendingChat = null;
  if (goToAnnotationSource(attachment, input)) return;
  const { source } = attachment;
  if (source.kind !== "chat") return;
  const tab = findChatTab(source);
  if (!tab) {
    input.onNotice(CHAT_UNREACHABLE_NOTICE);
    return;
  }
  revealWorkspaceTab(tab.workspaceKey, tab.tabId);
  const deadline = Date.now() + CHAT_TIMEOUT_MS;
  let frame = 0;
  function dispose() {
    cancelAnimationFrame(frame);
    if (cancelPendingChat === dispose) cancelPendingChat = null;
  }
  function attempt() {
    if (revealAnnotationSource(attachment)) {
      dispose();
      return;
    }
    if (Date.now() >= deadline) {
      dispose();
      input.onNotice(CHAT_UNREACHABLE_NOTICE);
      return;
    }
    frame = requestAnimationFrame(attempt);
  }
  cancelPendingChat = dispose;
  frame = requestAnimationFrame(attempt);
}
