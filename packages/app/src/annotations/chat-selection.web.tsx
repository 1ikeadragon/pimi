import { createAssistantSelectionClipboardContent } from "@/assistant-selection-copy/content.web";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { AnnotationAction, AnnotationEditor, type AnnotationAnchor } from "./popover.web";
import { addAnnotationToChat, type AnnotationTarget } from "./target";
import { ANNOTATION_CHARACTER_LIMIT, type AnnotationCapture } from "./model";

interface SelectionCapture {
  capture: AnnotationCapture;
  anchor: AnnotationAnchor;
  sourceElement: HTMLElement | null;
}
const DISPLAY_CONTENTS: CSSProperties = { display: "contents" };

function messageAtSelectionEdge(
  node: Node,
  root: HTMLElement,
): { id: string; role: "user" | "assistant" } | null {
  const element = node instanceof Element ? node : node.parentElement;
  if (!element || !root.contains(element) || !element.closest('[data-message-text="true"]'))
    return null;
  const message = element.closest(
    '[data-testid="user-message"], [data-testid="assistant-message"]',
  );
  const id = element.closest<HTMLElement>("[data-message-id]")?.dataset.messageId;
  if (!message || !id) return null;
  return {
    id,
    role: message.getAttribute("data-testid") === "user-message" ? "user" : "assistant",
  };
}

function captureSelection(
  root: HTMLElement,
  target: { serverId: string; agentId: string },
): SelectionCapture | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  const start = messageAtSelectionEdge(range.startContainer, root);
  const end = messageAtSelectionEdge(range.endContainer, root);
  if (!start || !end || start.id !== end.id || start.role !== end.role) return null;
  // Reuse the copy serializer for Markdown boundaries, retaining code whitespace for snapshots.
  const selectedText = selection.toString();
  const quote =
    start.role === "assistant" && selectedText.length <= ANNOTATION_CHARACTER_LIMIT
      ? createAssistantSelectionClipboardContent(selection, {
          preserveSelectedCodeWhitespace: true,
        })?.plainText
      : selectedText;
  if (!quote?.trim()) return null;
  const rect = range.getBoundingClientRect();
  if ((!rect.width && !rect.height) || rect.bottom <= 0 || rect.top >= window.innerHeight)
    return null;
  const capturedRange = range.cloneRange();
  const anchor = () => {
    const bounds = capturedRange.getBoundingClientRect();
    return { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height };
  };
  return {
    capture: { quote, source: { kind: "chat", ...target, messageId: start.id, role: start.role } },
    anchor,
    sourceElement:
      (range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement
      )?.closest<HTMLElement>('[data-testid="user-message"], [data-testid="assistant-message"]') ??
      null,
  };
}

export function ChatAnnotationSelection({
  children,
  target,
}: {
  children: ReactNode;
  target?: { serverId: string; agentId: string };
}) {
  const root = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<SelectionCapture | null>(null);
  const [draft, setDraft] = useState<{
    capture: AnnotationCapture;
    target: AnnotationTarget;
    anchor: AnnotationAnchor;
    sourceElement: HTMLElement | null;
  } | null>(null);
  const serverId = target?.serverId;
  const agentId = target?.agentId;
  useEffect(() => {
    setSelection(null);
    if (!serverId || !agentId || draft) return;
    let frame = 0;
    function update() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // Tabbing to the action must not discard the selected source.
        if (toolbar.current?.contains(document.activeElement)) return;
        setSelection(
          root.current
            ? captureSelection(root.current, { serverId: serverId!, agentId: agentId! })
            : null,
        );
      });
    }
    document.addEventListener("selectionchange", update);
    document.addEventListener("pointerup", update);
    document.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("pointerup", update);
      document.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [serverId, agentId, draft]);
  useEffect(() => {
    if (!selection) return;
    const focusAction = (event: KeyboardEvent) => {
      if (
        event.key !== "Tab" ||
        event.shiftKey ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.isComposing
      )
        return;
      const action = toolbar.current?.querySelector<HTMLElement>('[role="button"], button');
      if (!action || action.contains(document.activeElement)) return;
      event.preventDefault();
      action.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", focusAction, true);
    return () => document.removeEventListener("keydown", focusAction, true);
  }, [selection]);
  const annotate = useCallback(() => {
    if (!selection || !serverId || !agentId) return;
    setDraft({
      capture: selection.capture,
      anchor: selection.anchor,
      sourceElement: selection.sourceElement,
      target: { serverId, agentId, draftKey: buildDraftStoreKey({ serverId, agentId }) },
    });
    setSelection(null);
  }, [selection, serverId, agentId]);
  const closeDraft = useCallback(() => {
    setDraft(null);
    const source = draft?.sourceElement;
    if (!source?.isConnected) return;
    const previous = source.getAttribute("tabindex");
    source.tabIndex = -1;
    source.addEventListener(
      "blur",
      () => {
        if (previous === null) source.removeAttribute("tabindex");
        else source.setAttribute("tabindex", previous);
      },
      { once: true },
    );
    source.focus({ preventScroll: true });
  }, [draft]);
  const saveDraft = useCallback(
    async (note: string) => {
      if (!draft) throw new Error("The annotation is no longer available.");
      await addAnnotationToChat(draft.target, draft.capture, note);
    },
    [draft],
  );

  return (
    <>
      <div ref={root} style={DISPLAY_CONTENTS}>
        {children}
      </div>
      {selection && target ? (
        <AnnotationAction
          anchor={selection.anchor}
          onPress={annotate}
          actionRef={toolbar}
          label="Annotate selected text"
          testID="annotate-chat-selection"
        />
      ) : null}
      {draft ? (
        <AnnotationEditor
          capture={draft.capture}
          anchor={draft.anchor}
          canSave={Boolean(
            target && serverId === draft.target.serverId && agentId === draft.target.agentId,
          )}
          onClose={closeDraft}
          onSave={saveDraft}
        />
      ) : null}
    </>
  );
}
