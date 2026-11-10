import { createAssistantSelectionClipboardContent } from "@/assistant-selection-copy/content.web";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { useToast } from "@/contexts/toast-context";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { messageContents, observeChatHighlight } from "./chat-highlight.web";
import {
  registerAnnotationSource,
  type AnnotationEditorOutcome,
  type AnnotationEditSession,
} from "./edit-session";
import {
  AnnotationHighlightStyle,
  AnnotationNoteEditor,
  AnnotationToolbar,
  type AnnotationEditorHandle,
} from "./popover.web";
import {
  AnnotationTargetUnavailableError,
  addAnnotationToChat,
  focusAnnotationTarget,
  removeAnnotation,
  saveAnnotationNote,
} from "./target";
import {
  ANNOTATION_CHARACTER_LIMIT,
  type AnnotationCapture,
  type AnnotationTextSelector,
} from "./model";
import {
  isPointNearRect,
  isSelectionRectVisible,
  observeSelectionActions,
  resolveSelectionActionPosition,
  type SelectionActionPosition,
  type SelectionActions,
  type SelectionEdges,
  type SelectionPoint,
} from "./selection-actions.web";
import { captureTextSelector, resolveSelectorRange } from "./text-selector.web";

interface ChatTarget {
  serverId: string;
  agentId: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
}

interface ToolbarSelection {
  capture: AnnotationCapture;
  position: SelectionActionPosition;
}

interface ChatEditing {
  session: AnnotationEditSession;
  messageId: string;
  selector: AnnotationTextSelector;
  /** Live range over the quote; the highlight observer repairs it in place. */
  range: Range;
}

type Surface =
  | { kind: "idle" }
  | { kind: "toolbar"; selection: ToolbarSelection }
  | { kind: "editing"; editing: ChatEditing };

const IDLE: Surface = { kind: "idle" };
const DISPLAY_CONTENTS: CSSProperties = { display: "contents" };

function messageOfText(node: Text, root: HTMLElement): ChatMessage | null {
  const element = node.parentElement;
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

// Adapted from T3 Code apps/web/src/lib/assistantTextSelection.ts (MIT, © 2026 T3 Tools Inc.).
function selectedTextEdge(range: Range, node: Node, last: boolean): Text | null {
  if (!range.intersectsNode(node)) return null;
  if (node instanceof Text) {
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : node.length;
    return start < end ? node : null;
  }
  for (
    let child = last ? node.lastChild : node.firstChild;
    child !== null;
    child = last ? child.previousSibling : child.nextSibling
  ) {
    const edge = selectedTextEdge(range, child, last);
    if (edge) return edge;
  }
  return null;
}

/**
 * A triple click ends its range at the start of the next block, which can be the next message.
 * This range ends on the text that is selected instead.
 */
function selectedTextRange(selection: Range): Range | null {
  const first = selectedTextEdge(selection, selection.commonAncestorContainer, false);
  const last = selectedTextEdge(selection, selection.commonAncestorContainer, true);
  if (!first || !last) return null;
  const range = selection.cloneRange();
  range.setStart(first, first === selection.startContainer ? selection.startOffset : 0);
  range.setEnd(last, last === selection.endContainer ? selection.endOffset : last.length);
  return range;
}

/** The scrolling chat area: the first box under the layout-less wrappers. */
function paneBounds(root: HTMLElement): SelectionEdges {
  let element: Element = root;
  while (getComputedStyle(element).display === "contents" && element.firstElementChild) {
    element = element.firstElementChild;
  }
  return element.getBoundingClientRect();
}

function lineRects(range: Range): DOMRect[] {
  return Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
}

function visibleLines(range: Range, root: HTMLElement): DOMRect[] {
  const clips = [
    paneBounds(root),
    { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight },
  ];
  return lineRects(range).filter((line) => isSelectionRectVisible(line, clips));
}

interface SelectedMessageText {
  message: ChatMessage;
  range: Range;
}

/** The selected text, when all of it is in one message of this chat. */
function selectedMessageText(selection: Selection, root: HTMLElement): SelectedMessageText | null {
  if (selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selectedTextRange(selection.getRangeAt(0));
  if (!range || !(range.startContainer instanceof Text)) return null;
  if (!(range.endContainer instanceof Text)) return null;
  const start = messageOfText(range.startContainer, root);
  const end = messageOfText(range.endContainer, root);
  if (!start || !end || start.id !== end.id || start.role !== end.role) return null;
  return { message: start, range };
}

function selectionQuote(selection: Selection, message: ChatMessage): string | null {
  const selectedText = selection.toString();
  if (message.role === "user" || selectedText.length > ANNOTATION_CHARACTER_LIMIT) {
    return selectedText;
  }
  // Reuse the copy serializer for Markdown boundaries, retaining code whitespace for snapshots.
  const content = createAssistantSelectionClipboardContent(selection, {
    preserveSelectedCodeWhitespace: true,
  });
  return content?.plainText ?? null;
}

function captureSelection(
  root: HTMLElement,
  target: ChatTarget,
  pointer: SelectionPoint | null,
): ToolbarSelection | null {
  const selection = window.getSelection();
  const selected = selection && selectedMessageText(selection, root);
  if (!selection || !selected) return null;
  const { message } = selected;
  const quote = selectionQuote(selection, message);
  if (!quote?.trim()) return null;

  const contents = messageContents(root, message.id);
  const selector = captureTextSelector(contents, selected.range) ?? undefined;
  const range = (selector && resolveSelectorRange(contents, selector)) ?? selected.range;
  if (visibleLines(range, root).length === 0) return null;
  const lines = lineRects(range);
  const lastLine = lines[lines.length - 1];
  if (!lastLine) return null;
  const pointerOnText = pointer !== null && lines.some((line) => isPointNearRect(pointer, line));
  return {
    capture: {
      quote,
      selector,
      source: { kind: "chat", ...target, messageId: message.id, role: message.role },
    },
    position: resolveSelectionActionPosition({
      bounds: paneBounds(root),
      lastLine,
      pointer: pointerOnText ? pointer : null,
    }),
  };
}

function ChatAnnotationEditor({
  editing,
  root,
  frameRef,
  onClose,
}: {
  editing: ChatEditing;
  root: RefObject<HTMLDivElement | null>;
  frameRef: RefObject<HTMLDivElement | null>;
  onClose(outcome: AnnotationEditorOutcome): void;
}) {
  const handle = useRef<AnnotationEditorHandle>(null);
  const { messageId, selector, range } = editing;
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    return observeChatHighlight({
      root: element,
      messageId,
      selector,
      range,
      onUnavailable: () => handle.current?.dismiss(),
    });
  }, [root, messageId, selector, range]);
  const anchor = useCallback(() => {
    const lines = lineRects(range);
    const last = lines[lines.length - 1];
    if (!last) return null;
    const top = Math.min(...lines.map((line) => line.top));
    return { x: last.left, y: top, width: last.width, height: last.bottom - top };
  }, [range]);
  const bounds = useCallback(() => (root.current ? paneBounds(root.current) : null), [root]);
  return (
    <AnnotationNoteEditor
      session={editing.session}
      anchor={anchor}
      bounds={bounds}
      frameRef={frameRef}
      handleRef={handle}
      onClose={onClose}
    />
  );
}

export function ChatAnnotationSelection({
  children,
  target,
}: {
  children: ReactNode;
  target?: ChatTarget;
}) {
  const root = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const editorFrame = useRef<HTMLDivElement>(null);
  const actions = useRef<SelectionActions | null>(null);
  const [surface, setSurface] = useState<Surface>(IDLE);
  const toast = useToast();
  const serverId = target?.serverId;
  const agentId = target?.agentId;

  useEffect(() => {
    const element = root.current;
    if (!element || !serverId || !agentId) return;
    const observed = observeSelectionActions({
      element,
      getActionElements: () => [toolbar.current, editorFrame.current],
      onSelection(pointer) {
        const selection = captureSelection(element, { serverId, agentId }, pointer);
        setSurface((current) => {
          if (current.kind === "editing") return current;
          return selection ? { kind: "toolbar", selection } : IDLE;
        });
      },
      onDismiss() {
        setSurface((current) => (current.kind === "toolbar" ? IDLE : current));
      },
    });
    actions.current = observed;
    document.addEventListener("selectionchange", observed.selectionChanged);
    return () => {
      document.removeEventListener("selectionchange", observed.selectionChanged);
      observed.dispose();
      actions.current = null;
      setSurface((current) => (current.kind === "toolbar" ? IDLE : current));
    };
  }, [serverId, agentId]);

  const toolbarVisible = surface.kind === "toolbar";
  useEffect(() => {
    if (!toolbarVisible) return;
    function focusToolbar(event: KeyboardEvent) {
      const plainTab =
        event.key === "Tab" &&
        !event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.isComposing &&
        !event.defaultPrevented;
      if (!plainTab) return;
      const action = toolbar.current?.querySelector<HTMLElement>(
        '[role="button"]:not([aria-disabled="true"]), button:not([disabled])',
      );
      if (!action || action.contains(document.activeElement)) return;
      event.preventDefault();
      event.stopPropagation();
      action.focus({ preventScroll: true });
    }
    document.addEventListener("keydown", focusToolbar, true);
    return () => document.removeEventListener("keydown", focusToolbar, true);
  }, [toolbarVisible]);

  const openEditor = useCallback(
    (session: AnnotationEditSession): boolean => {
      const element = root.current;
      const { source, quote } = session.attachment;
      if (!element || source.kind !== "chat") return false;
      if (source.serverId !== serverId || source.agentId !== agentId) return false;
      // Drafts saved before quotes carried context still resolve when the quote appears once.
      const selector = session.attachment.selector ?? { text: quote, prefix: "", suffix: "" };
      const range = resolveSelectorRange(messageContents(element, source.messageId), selector);
      if (!range || visibleLines(range, element).length === 0) return false;
      setSurface({
        kind: "editing",
        editing: { session, messageId: source.messageId, selector, range },
      });
      return true;
    },
    [serverId, agentId],
  );

  useEffect(() => {
    if (!serverId || !agentId) return;
    return registerAnnotationSource(openEditor);
  }, [serverId, agentId, openEditor]);

  const annotate = useCallback(async () => {
    if (surface.kind !== "toolbar" || !serverId || !agentId) return;
    const annotationTarget = {
      serverId,
      agentId,
      draftKey: buildDraftStoreKey({ serverId, agentId }),
    };
    actions.current?.cancel();
    window.getSelection()?.removeAllRanges();
    setSurface(IDLE);
    try {
      const attachment = await addAnnotationToChat(annotationTarget, surface.selection.capture);
      const opened = openEditor({
        attachment,
        isNew: true,
        saveNote: (note) => saveAnnotationNote(annotationTarget, attachment.id, note),
        remove: () => removeAnnotation(annotationTarget, attachment.id),
        onClosed: (outcome) => {
          if (outcome !== "dismissed") focusAnnotationTarget(annotationTarget);
        },
      });
      if (!opened) focusAnnotationTarget(annotationTarget);
    } catch (error) {
      if (!(error instanceof AnnotationTargetUnavailableError)) throw error;
      toast.error(error.message);
    }
  }, [surface, serverId, agentId, toast, openEditor]);
  const handleAnnotate = useCallback(() => void annotate(), [annotate]);
  const dismissToolbar = useCallback(() => {
    actions.current?.cancel();
    setSurface((current) => (current.kind === "toolbar" ? IDLE : current));
  }, []);

  const editing = surface.kind === "editing" ? surface.editing : null;
  const openSession = useRef<AnnotationEditSession | null>(null);
  openSession.current = editing?.session ?? null;
  useEffect(
    () => () => {
      // This chat is going away with its highlight. Unmounting the note editor keeps a changed
      // note; the session's owner still has to hear that it ended.
      openSession.current?.onClosed("dismissed");
      setSurface(IDLE);
    },
    [serverId, agentId],
  );
  const closeEditor = useCallback(
    (outcome: AnnotationEditorOutcome) => {
      setSurface((current) => (current.kind === "editing" ? IDLE : current));
      editing?.session.onClosed(outcome);
    },
    [editing],
  );

  return (
    <>
      <div ref={root} style={DISPLAY_CONTENTS}>
        {children}
      </div>
      {target ? <AnnotationHighlightStyle /> : null}
      {surface.kind === "toolbar" && target ? (
        <AnnotationToolbar
          position={surface.selection.position}
          onPress={handleAnnotate}
          onDismiss={dismissToolbar}
          toolbarRef={toolbar}
          tooLong={surface.selection.capture.quote.length > ANNOTATION_CHARACTER_LIMIT}
          testID="annotation-toolbar-button"
        />
      ) : null}
      {editing ? (
        <ChatAnnotationEditor
          key={editing.session.attachment.id}
          editing={editing}
          root={root}
          frameRef={editorFrame}
          onClose={closeEditor}
        />
      ) : null}
    </>
  );
}
