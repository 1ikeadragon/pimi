import { AnnotationLimitError } from "@/composer/chips/model";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { useToast } from "@/contexts/toast-context";
import {
  registerAnnotationRevealer,
  registerAnnotationSource,
  type AnnotationEditorOutcome,
  type AnnotationEditSession,
} from "./edit-session";
import { ANNOTATION_CHARACTER_LIMIT, type AnnotationCapture, type AnnotationSource } from "./model";
import {
  ANNOTATION_MARK_CLASS,
  ANNOTATION_PULSE_MARK_CLASS,
  AnnotationHighlightStyle,
  AnnotationNoteEditor,
  AnnotationToolbar,
  type AnnotationEditorHandle,
} from "./popover.web";
import {
  ANNOTATION_PULSE_TOTAL_MS,
  ANNOTATION_SOURCE_TOP_OFFSET_PX,
  annotationPulseKeyframes,
  prefersReducedMotion,
} from "./pulse.web";
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
import {
  AnnotationTargetUnavailableError,
  addAnnotationToChat,
  focusAnnotationTarget,
  removeAnnotation,
  saveAnnotationNote,
  type AnnotationTarget,
} from "./target";

interface DocRange {
  from: number;
  to: number;
}

interface FileIdentity {
  serverId: string;
  workspaceId: string;
  path: string;
}

interface ToolbarSelection {
  capture: AnnotationCapture;
  range: DocRange;
  position: SelectionActionPosition;
}

type Surface =
  | { kind: "idle" }
  | { kind: "toolbar"; selection: ToolbarSelection }
  | { kind: "editing"; session: AnnotationEditSession };

const IDLE: Surface = { kind: "idle" };

const setHighlight = StateEffect.define<DocRange | null>();
const highlightMark = Decoration.mark({ class: ANNOTATION_MARK_CLASS });
const highlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setHighlight)) continue;
      const range = effect.value;
      next =
        range && range.from < range.to
          ? Decoration.set([highlightMark.range(range.from, range.to)])
          : Decoration.none;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const setPulse = StateEffect.define<DocRange | null>();
const pulseMark = Decoration.mark({ class: ANNOTATION_PULSE_MARK_CLASS });
const pulseField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setPulse)) continue;
      const range = effect.value;
      next =
        range && range.from < range.to
          ? Decoration.set([pulseMark.range(range.from, range.to)])
          : Decoration.none;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const updateListeners = new WeakMap<EditorView, (update: ViewUpdate) => void>();

/** Add to the editor's extensions; `EditorAnnotationSelection` drives it. */
export const annotationEditorExtension: Extension = [
  highlightField,
  pulseField,
  EditorView.updateListener.of((update) => updateListeners.get(update.view)?.(update)),
];

/** Where the highlighted text is now; edits to the file move it, and deleting it clears it. */
function highlightedRange(view: EditorView): DocRange | null {
  const cursor = view.state.field(highlightField).iter();
  return cursor.value ? { from: cursor.from, to: cursor.to } : null;
}

function paneBounds(view: EditorView): SelectionEdges {
  return view.scrollDOM.getBoundingClientRect();
}

/** The end of the selection's last line, when the pane is showing it. */
function visibleRangeEnd(view: EditorView, range: DocRange): SelectionEdges | null {
  const end = view.coordsAtPos(range.to, -1);
  if (!end) return null;
  const bounds = paneBounds(view);
  const band = { left: bounds.left, right: bounds.right, top: end.top, bottom: end.bottom };
  const viewport = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  return isSelectionRectVisible(band, [bounds, viewport]) ? end : null;
}

/** The caret box under the pointer, when the pointer was released on the selected text. */
function pointerRectOnRange(
  view: EditorView,
  pointer: SelectionPoint,
  range: DocRange,
): SelectionEdges | null {
  const position = view.posAtCoords(pointer, false);
  if (position < range.from || position > range.to) return null;
  const at = view.coordsAtPos(position);
  return at && isPointNearRect(pointer, at) ? at : null;
}

function captureSelection(input: {
  view: EditorView;
  file: FileIdentity;
  lineSeparator: string | undefined;
  pointer: SelectionPoint | null;
}): ToolbarSelection | null {
  const { view, file, lineSeparator, pointer } = input;
  const { doc, selection } = view.state;
  if (selection.ranges.length !== 1 || selection.main.empty) return null;
  const { from, to } = selection.main;
  const quote = doc.sliceString(from, to, lineSeparator);
  if (!quote.trim()) return null;
  const range = { from, to };
  const pointerRect = pointer ? pointerRectOnRange(view, pointer, range) : null;
  const lastLine = visibleRangeEnd(view, range) ?? pointerRect;
  if (!lastLine) return null;
  const first = doc.lineAt(from);
  const last = doc.lineAt(to);
  return {
    range,
    capture: {
      quote,
      source: {
        kind: "file",
        ...file,
        startLine: first.number,
        startColumn: from - first.from + 1,
        endLine: last.number,
        endColumn: to - last.from + 1,
      },
    },
    position: resolveSelectionActionPosition({
      bounds: paneBounds(view),
      lastLine,
      pointer: pointerRect ? pointer : null,
    }),
  };
}

/** Finds an annotation's text in the file as it is now: at its saved lines, or wherever it is unique. */
function locateQuote(
  state: EditorState,
  source: Extract<AnnotationSource, { kind: "file" }>,
  quote: string,
): DocRange | null {
  const { doc } = state;
  const text = quote.replace(/\r\n?/g, "\n");
  if (source.startLine <= doc.lines && source.endLine <= doc.lines) {
    const from = doc.line(source.startLine).from + source.startColumn - 1;
    const to = doc.line(source.endLine).from + source.endColumn - 1;
    if (from < to && to <= doc.length && doc.sliceString(from, to) === text) return { from, to };
  }
  const content = doc.toString();
  const index = content.indexOf(text);
  const unique = index !== -1 && content.indexOf(text, index + 1) === -1;
  return unique ? { from: index, to: index + text.length } : null;
}

let currentPulse: (() => void) | null = null;

/**
 * Scrolls the editor until the annotated code sits near its top, puts the cursor at its start, and
 * pulses it the way a chat quote pulses. Only one source pulses at a time. Returns false when the
 * code is no longer in the file; the editor then shows the saved lines without a pulse.
 */
function revealEditorRange(
  view: EditorView,
  source: Extract<AnnotationSource, { kind: "file" }>,
  quote: string,
): boolean {
  currentPulse?.();
  const range = locateQuote(view.state, source, quote);
  const offset = Math.min(ANNOTATION_SOURCE_TOP_OFFSET_PX, view.scrollDOM.clientHeight / 3);
  if (!range) {
    const { doc } = view.state;
    const line = doc.line(Math.min(source.startLine, doc.lines));
    view.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: "start", yMargin: offset }),
    });
    return false;
  }
  view.dispatch({
    selection: { anchor: range.from },
    effects: [
      EditorView.scrollIntoView(range.from, { y: "start", yMargin: offset }),
      setPulse.of(range),
    ],
  });
  // The mark inherits the opacity, so the editor content keeps animating it across line redraws.
  const animation = view.contentDOM.animate(annotationPulseKeyframes(prefersReducedMotion()), {
    duration: ANNOTATION_PULSE_TOTAL_MS,
    easing: "ease-in-out",
  });
  let stopped = false;
  function dispose() {
    if (stopped) return;
    stopped = true;
    if (currentPulse === dispose) currentPulse = null;
    animation.cancel();
    if (view.dom.isConnected) view.dispatch({ effects: setPulse.of(null) });
  }
  currentPulse = dispose;
  animation.finished.then(dispose, () => {});
  return true;
}

export function EditorAnnotationSelection({
  editor,
  epoch,
  file,
  target,
  getLineSeparator,
}: {
  /** Holds null until the editor is created, and again while it is being replaced. */
  editor: RefObject<EditorView | null>;
  /** Changes whenever `editor` points at a different instance. */
  epoch: number;
  file: FileIdentity;
  /** The chat annotations go to; null when the workspace has none to receive them. */
  target: AnnotationTarget | null;
  getLineSeparator(): string | undefined;
}) {
  const [view, setView] = useState<EditorView | null>(null);
  useEffect(() => {
    setView(editor.current);
  }, [editor, epoch]);
  const toolbar = useRef<HTMLDivElement>(null);
  const editorFrame = useRef<HTMLDivElement>(null);
  const editorHandle = useRef<AnnotationEditorHandle>(null);
  const actions = useRef<SelectionActions | null>(null);
  const [surface, setSurface] = useState<Surface>(IDLE);
  const toast = useToast();
  const { serverId, workspaceId, path } = file;
  const canAnnotate = target !== null;
  const lineSeparator = useRef(getLineSeparator);
  lineSeparator.current = getLineSeparator;

  useEffect(() => {
    if (!view || !canAnnotate) return;
    const observed = observeSelectionActions({
      element: view.dom,
      getActionElements: () => [toolbar.current, editorFrame.current],
      onSelection(pointer) {
        const selection = captureSelection({
          view,
          file: { serverId, workspaceId, path },
          lineSeparator: lineSeparator.current(),
          pointer,
        });
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
    return () => {
      observed.dispose();
      actions.current = null;
      setSurface((current) => (current.kind === "toolbar" ? IDLE : current));
    };
  }, [view, canAnnotate, serverId, workspaceId, path]);

  useEffect(() => {
    if (!view) return;
    updateListeners.set(view, (update) => {
      // Find and go-to-line move the selection without the editor holding focus.
      if (update.selectionSet && update.view.hasFocus) actions.current?.selectionChanged();
      // Closing clears the highlight, and a view cannot be dispatched to from inside its update.
      if (update.docChanged && !highlightedRange(update.view)) {
        queueMicrotask(() => editorHandle.current?.dismiss());
      }
    });
    return () => {
      updateListeners.delete(view);
    };
  }, [view]);

  const editingSession = surface.kind === "editing" ? surface.session : null;
  const openSession = useRef(editingSession);
  openSession.current = editingSession;
  useEffect(() => {
    if (!view) return;
    return () => {
      // This editor is going away with its highlight. Unmounting the note editor keeps a
      // changed note; the session's owner still has to hear that it ended.
      openSession.current?.onClosed("dismissed");
      setSurface(IDLE);
    };
  }, [view]);

  const startEditing = useCallback(
    (session: AnnotationEditSession, range: DocRange) => {
      view?.dispatch({ effects: setHighlight.of(range) });
      setSurface({ kind: "editing", session });
    },
    [view],
  );

  const openEditor = useCallback(
    (session: AnnotationEditSession): boolean => {
      const { source, quote } = session.attachment;
      if (!view || !view.dom.isConnected || source.kind !== "file") return false;
      const sameFile =
        source.serverId === serverId && source.workspaceId === workspaceId && source.path === path;
      if (!sameFile) return false;
      const range = locateQuote(view.state, source, quote);
      if (!range || !visibleRangeEnd(view, range)) return false;
      startEditing(session, range);
      return true;
    },
    [view, serverId, workspaceId, path, startEditing],
  );

  useEffect(() => registerAnnotationSource(openEditor), [openEditor]);

  const revealSource = useCallback(
    (attachment: AnnotationCapture): boolean => {
      const { source, quote } = attachment;
      if (!view || !view.dom.isConnected || source.kind !== "file") return false;
      const sameFile =
        source.serverId === serverId && source.workspaceId === workspaceId && source.path === path;
      // An editor in a hidden pane or tab has no size and cannot scroll.
      if (!sameFile || view.scrollDOM.clientHeight === 0) return false;
      if (!revealEditorRange(view, source, quote)) {
        toast.show("The annotated code has changed. Showing its lines instead.", {
          variant: "warning",
        });
      }
      return true;
    },
    [view, serverId, workspaceId, path, toast],
  );

  useEffect(() => registerAnnotationRevealer(revealSource), [revealSource]);

  const annotate = useCallback(async () => {
    if (surface.kind !== "toolbar" || !target) return;
    const { capture, range } = surface.selection;
    actions.current?.cancel();
    setSurface(IDLE);
    try {
      const attachment = await addAnnotationToChat(target, capture);
      startEditing(
        {
          attachment,
          isNew: true,
          saveNote: (note) => saveAnnotationNote(target, attachment.id, note),
          remove: () => removeAnnotation(target, attachment.id),
          onClosed: (outcome) => {
            if (outcome !== "dismissed") focusAnnotationTarget(target);
          },
        },
        range,
      );
    } catch (error) {
      if (
        !(
          error instanceof AnnotationTargetUnavailableError || error instanceof AnnotationLimitError
        )
      )
        throw error;
      toast.error(error.message);
    }
  }, [surface, target, toast, startEditing]);
  const handleAnnotate = useCallback(() => void annotate(), [annotate]);
  const dismissToolbar = useCallback(() => {
    actions.current?.cancel();
    setSurface((current) => (current.kind === "toolbar" ? IDLE : current));
  }, []);

  const closeEditor = useCallback(
    (outcome: AnnotationEditorOutcome) => {
      view?.dispatch({ effects: setHighlight.of(null) });
      setSurface((current) => (current.kind === "editing" ? IDLE : current));
      if (!editingSession) return;
      // Nothing was added, so the user stays in the file instead of being sent to the chat.
      if (outcome === "cancelled" && editingSession.isNew) view?.focus();
      else editingSession.onClosed(outcome);
    },
    [view, editingSession],
  );

  const anchor = useCallback(() => {
    const range = view ? highlightedRange(view) : null;
    // A pane hidden behind another tab has no box to anchor to.
    if (!view || !range || view.scrollDOM.clientHeight === 0) return null;
    const end = view.coordsAtPos(range.to, -1);
    if (!end) return null;
    const { doc } = view.state;
    // A range ending at a line's first column has its last selected text on the line before.
    const lastSelected = doc.lineAt(range.to).from === range.to ? range.to - 1 : range.to;
    const lineStart = Math.max(range.from, doc.lineAt(lastSelected).from);
    const left = view.coordsAtPos(lineStart, 1)?.left ?? end.left;
    const top = Math.min(view.coordsAtPos(range.from, 1)?.top ?? end.top, end.top);
    return { x: left, y: top, width: Math.max(0, end.right - left), height: end.bottom - top };
  }, [view]);
  const bounds = useCallback(() => (view ? paneBounds(view) : null), [view]);

  return (
    <>
      <AnnotationHighlightStyle />
      {surface.kind === "toolbar" ? (
        <AnnotationToolbar
          position={surface.selection.position}
          onPress={handleAnnotate}
          onDismiss={dismissToolbar}
          toolbarRef={toolbar}
          tooLong={surface.selection.capture.quote.length > ANNOTATION_CHARACTER_LIMIT}
          testID="annotation-toolbar-button"
        />
      ) : null}
      {editingSession ? (
        <AnnotationNoteEditor
          key={editingSession.attachment.id}
          session={editingSession}
          anchor={anchor}
          bounds={bounds}
          frameRef={editorFrame}
          handleRef={editorHandle}
          onClose={closeEditor}
        />
      ) : null}
    </>
  );
}
