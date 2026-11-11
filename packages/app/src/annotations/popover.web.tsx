import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { MessageSquarePlus } from "lucide-react-native";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { Button } from "@/components/ui/button";
import { computePosition, type Placement, type Rect } from "@/components/ui/anchor";
import { useOverlayRegistration, type KeyboardInputEvent } from "@/keyboard";
import { getOverlayRoot, useGlobalOverlayLayer } from "@/lib/overlay-root";
import { SPACING } from "@/styles/theme";
import type { AnnotationEditorOutcome, AnnotationEditSession } from "./edit-session";
import { annotationNoteError } from "./model";
import {
  SELECTION_ACTION_GAP,
  WINDOW_EDGE_GAP,
  placeSelectionAction,
  type SelectionActionPosition,
  type SelectionEdges,
} from "./selection-actions.web";

/** The annotated text, as one rect: the editor sits under its bottom edge or over its top. */
export type AnnotationAnchor = () => Rect | null;
export type AnnotationBounds = () => SelectionEdges | null;

export interface AnnotationEditorHandle {
  /** The source went away: keep a changed note and close. */
  dismiss(): void;
}

export const ANNOTATION_HIGHLIGHT_NAME = "pimi-annotation";
/** A rounded box over the chat quote a composer pill went to; its layer fades in and out. */
export const ANNOTATION_PULSE_BOX_CLASS = "pimi-annotation-pulse-box";
/** Animated on the code editor content; the code pulse mark inherits it. */
export const ANNOTATION_PULSE_OPACITY = "--pimi-annotation-pulse-opacity";
export const ANNOTATION_MARK_CLASS = "cm-pimi-annotation";
/** The code a composer pill went to, pulsing with the opacity animated on the editor content. */
export const ANNOTATION_PULSE_MARK_CLASS = "cm-pimi-annotation-pulse";

const EDITOR_WIDTH = 320;
const INPUT_MIN_HEIGHT = 56;
const INPUT_MAX_HEIGHT = 160;
const ENTER_ANIMATION_NAME = "pimi-annotation-enter";
const ENTER_DURATION_MS = 130;

function ensureEnterKeyframes() {
  if (document.getElementById(ENTER_ANIMATION_NAME)) return;
  const style = document.createElement("style");
  style.id = ENTER_ANIMATION_NAME;
  style.textContent = `@media (prefers-reduced-motion: no-preference) { @keyframes ${ENTER_ANIMATION_NAME} { from { opacity: 0; transform: scale(0.98); } to { opacity: 1; transform: scale(1); } } }`;
  document.head.appendChild(style);
}
ensureEnterKeyframes();

const ESCAPE_KEY = ["Escape"] as const;
const EDITOR_KEYS = ["Escape", "Enter"] as const;

const ENTER_STYLE: CSSProperties = {
  animationName: ENTER_ANIMATION_NAME,
  animationDuration: `${ENTER_DURATION_MS}ms`,
  animationTimingFunction: "ease-out",
  transformOrigin: "top left",
};

// Adapted from T3 Code apps/web/src/index.css (MIT, © 2026 T3 Tools Inc.).
/**
 * Paints annotated text in chat and in the code editor: a solid accent tint on the text whose note
 * is open, and the pulse on a quote or code a composer pill just went to. Saved annotations are not marked.
 */
export function AnnotationHighlightStyle() {
  const accent = styles.highlight.color;
  const active = `color-mix(in srgb, ${accent} 45%, transparent)`;
  const pulse = `color-mix(in srgb, ${accent} calc(var(${ANNOTATION_PULSE_OPACITY}) * 100%), transparent)`;
  return (
    <style>{`@property ${ANNOTATION_PULSE_OPACITY} { syntax: "<number>"; inherits: true; initial-value: 0; } ::highlight(${ANNOTATION_HIGHLIGHT_NAME}) { background-color: ${active}; } .${ANNOTATION_MARK_CLASS} { background-color: ${active}; } .${ANNOTATION_PULSE_BOX_CLASS} { position: absolute; border-radius: 4px; background-color: ${active}; } .${ANNOTATION_PULSE_MARK_CLASS} { background-color: ${pulse}; }`}</style>
  );
}

function keepSelection(event: MouseEvent<HTMLDivElement>) {
  event.preventDefault();
}

function useFloatingFrameStyle(layer: number, width?: number): CSSProperties {
  return useMemo(
    () => ({
      position: "fixed",
      pointerEvents: "auto",
      zIndex: layer,
      width,
      maxWidth: `calc(100vw - ${SPACING[2] * 2}px)`,
      visibility: "hidden",
    }),
    [layer, width],
  );
}

export function AnnotationToolbar({
  position,
  onPress,
  onDismiss,
  toolbarRef,
  tooLong,
  testID,
}: {
  position: SelectionActionPosition;
  onPress(): void;
  /** Escape was pressed. */
  onDismiss(): void;
  toolbarRef: RefObject<HTMLDivElement | null>;
  /** The selection is over the annotation size limit. */
  tooLong: boolean;
  testID: string;
}) {
  const layer = useGlobalOverlayLayer("floating", true);
  const frameStyle = useFloatingFrameStyle(layer);
  // Claims Escape while it is up, so the key closes the toolbar and does not interrupt the agent.
  const escape = useCallback(
    (event: KeyboardInputEvent) => {
      if (event.key !== "Escape") return false;
      event.preventDefault();
      onDismiss();
      return true;
    },
    [onDismiss],
  );
  useOverlayRegistration({
    active: true,
    layer,
    keys: ESCAPE_KEY,
    onKeyDown: escape,
    manageFocus: false,
  });
  useLayoutEffect(() => {
    const element = toolbarRef.current;
    if (!element) return;
    const point = placeSelectionAction(position, element.getBoundingClientRect());
    element.style.left = `${point.x}px`;
    element.style.top = `${point.y}px`;
    element.style.visibility = "visible";
  }, [position, toolbarRef]);
  return createPortal(
    // Pressing the button must not clear the selection it acts on.
    <div ref={toolbarRef} style={frameStyle} onMouseDown={keepSelection}>
      <div style={ENTER_STYLE}>
        <Button
          size="sm"
          variant="secondary"
          leftIcon={MessageSquarePlus}
          onPress={onPress}
          disabled={tooLong}
          style={styles.toolbarButton}
          accessibilityLabel={tooLong ? "Selection is too long to annotate" : "Annotate selection"}
          testID={testID}
        >
          {tooLong ? "Shorten selection" : "Annotate"}
        </Button>
      </div>
    </div>,
    getOverlayRoot(),
  );
}

function windowArea(): Rect {
  const viewport = window.visualViewport;
  return {
    x: viewport?.offsetLeft ?? 0,
    y: viewport?.offsetTop ?? 0,
    width: viewport?.width ?? window.innerWidth,
    height: viewport?.height ?? window.innerHeight,
  };
}

/** The pane the editor should stay inside, unless the pane is too small to hold it. */
function displayAreaFor(bounds: SelectionEdges | null, content: DOMRect): Rect {
  const area = windowArea();
  if (!bounds) return area;
  const left = Math.max(area.x, bounds.left);
  const top = Math.max(area.y, bounds.top);
  const width = Math.min(area.x + area.width, bounds.right) - left;
  const height = Math.min(area.y + area.height, bounds.bottom) - top;
  const fits =
    width >= content.width + WINDOW_EDGE_GAP * 2 && height >= content.height + WINDOW_EDGE_GAP * 2;
  return fits ? { x: left, y: top, width, height } : area;
}

function AnchoredSurface({
  anchor,
  bounds,
  placement,
  layer,
  frameRef,
  children,
}: {
  anchor: AnnotationAnchor;
  bounds?: AnnotationBounds;
  placement: Placement;
  layer: number;
  frameRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const frameStyle = useFloatingFrameStyle(layer, EDITOR_WIDTH);
  useLayoutEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    let frame = 0;
    function position() {
      const rect = anchor();
      if (!element) return;
      if (!rect) {
        // The annotated text is not laid out right now, as when its pane is hidden.
        element.style.visibility = "hidden";
        return;
      }
      const contentSize = element.getBoundingClientRect();
      const point = computePosition({
        triggerRect: rect,
        contentSize,
        displayArea: displayAreaFor(bounds?.() ?? null, contentSize),
        placement,
        alignment: "start",
        offset: SELECTION_ACTION_GAP,
      });
      element.style.left = `${point.x}px`;
      element.style.top = `${point.y}px`;
      element.style.visibility = "visible";
    }
    function schedule() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(position);
    }
    position();
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    document.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
    };
  }, [anchor, bounds, placement, frameRef]);
  return createPortal(
    <div ref={frameRef} style={frameStyle}>
      <div style={ENTER_STYLE}>{children}</div>
    </div>,
    getOverlayRoot(),
  );
}

function growToContent(input: EditingTextInputHandle | null) {
  const element = input?.getNativeRef();
  if (!(element instanceof HTMLTextAreaElement)) return;
  element.style.height = "auto";
  const height = Math.min(INPUT_MAX_HEIGHT, Math.max(INPUT_MIN_HEIGHT, element.scrollHeight));
  element.style.height = `${height}px`;
}

/**
 * The note for one annotation. Enter saves, Shift+Enter breaks the line, Escape cancels, and a
 * press outside keeps whatever was typed.
 */
export function AnnotationNoteEditor({
  session,
  anchor,
  bounds,
  placement = "bottom",
  frameRef,
  handleRef,
  onClose,
}: {
  session: AnnotationEditSession;
  anchor: AnnotationAnchor;
  bounds?: AnnotationBounds;
  placement?: Placement;
  /** The editor's outermost element, for owners that must tell its presses from the source's. */
  frameRef: RefObject<HTMLDivElement | null>;
  handleRef?: Ref<AnnotationEditorHandle>;
  onClose(outcome: AnnotationEditorOutcome): void;
}) {
  const input = useRef<EditingTextInputHandle>(null);
  // Only this editor changes the note while it is open, so the note it opened with is the saved one.
  const [savedNote] = useState(session.attachment.note);
  const [note, setNote] = useState(savedNote);
  const noteRef = useRef(note);
  noteRef.current = note;
  const layer = useGlobalOverlayLayer("floating", true);
  const error = annotationNoteError(note);

  // The portal is measured before it becomes visible; focus after that layout pass.
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      growToContent(input.current);
      input.current?.focus();
      input.current?.setSelection({ start: savedNote.length, end: savedNote.length });
    });
    return () => cancelAnimationFrame(frame);
  }, [savedNote]);

  const closed = useRef(false);
  const close = useCallback(
    (outcome: AnnotationEditorOutcome) => {
      closed.current = true;
      onClose(outcome);
    },
    [onClose],
  );
  const keepChangedNote = useCallback(() => {
    const current = noteRef.current.trim();
    const changed = current !== savedNote.trim();
    if (changed && !annotationNoteError(current)) session.saveNote(current);
    return changed;
  }, [savedNote, session]);
  const keepChangedNoteRef = useRef(keepChangedNote);
  keepChangedNoteRef.current = keepChangedNote;
  // The owning surface can go away under an open editor, as when its tab closes.
  useEffect(
    () => () => {
      if (!closed.current) keepChangedNoteRef.current();
    },
    [],
  );

  const changeNote = useCallback((text: string) => {
    setNote(text);
    growToContent(input.current);
  }, []);

  const save = useCallback(() => {
    if (annotationNoteError(noteRef.current)) return;
    keepChangedNote();
    close("saved");
  }, [close, keepChangedNote]);

  const cancel = useCallback(() => {
    if (session.isNew) session.remove();
    close("cancelled");
  }, [close, session]);

  // Adapted from T3 Code apps/web/src/components/chat/assistantCitationCommentDismissal.ts (MIT, © 2026 T3 Tools Inc.).
  const dismiss = useCallback(
    (reason: "outside-press" | "source-gone") => {
      const unsavable = keepChangedNote() && annotationNoteError(noteRef.current) !== null;
      // A note that cannot be saved stays open so a stray press does not lose it.
      if (unsavable && reason === "outside-press") return;
      close("dismissed");
    },
    [close, keepChangedNote],
  );

  useImperativeHandle(handleRef, () => ({ dismiss: () => dismiss("source-gone") }), [dismiss]);

  useLayoutEffect(() => {
    function pressedOutside(event: PointerEvent) {
      const frame = frameRef.current;
      if (!frame || !(event.target instanceof Node) || frame.contains(event.target)) return;
      dismiss("outside-press");
    }
    document.addEventListener("pointerdown", pressedOutside, true);
    return () => document.removeEventListener("pointerdown", pressedOutside, true);
  }, [dismiss, frameRef]);

  const keyDown = useCallback(
    (event: KeyboardInputEvent) => {
      // An IME confirms a candidate with Enter and cancels one with Escape.
      if (event.isComposing) return false;
      if (event.key === "Escape") {
        event.preventDefault();
        cancel();
        return true;
      }
      if (event.key === "Enter" && !event.shiftKey && input.current?.isFocused()) {
        event.preventDefault();
        save();
        return true;
      }
      return false;
    },
    [cancel, save],
  );
  const scope = useOverlayRegistration({
    active: true,
    layer,
    keys: EDITOR_KEYS,
    onKeyDown: keyDown,
    manageFocus: false,
  });

  return (
    <AnchoredSurface
      anchor={anchor}
      bounds={bounds}
      placement={placement}
      layer={layer}
      frameRef={frameRef}
    >
      <View
        ref={scope}
        style={styles.editor}
        role="dialog"
        accessibilityLabel="Annotation note"
        testID="annotation-editor"
      >
        <EditingTextInput
          ref={input}
          multiline
          initialValue={savedNote}
          onChangeText={changeNote}
          style={styles.input}
          accessibilityLabel="Note"
          accessibilityHint="Enter saves. Shift+Enter adds a line."
          placeholder="Add a note (optional)"
          testID="annotation-note-input"
        />
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}
        <View style={styles.footer}>
          <Text style={styles.hint}>Enter to save</Text>
          <Button size="sm" variant="ghost" onPress={cancel} testID="annotation-cancel">
            Cancel
          </Button>
          <Button
            size="sm"
            variant="default"
            onPress={save}
            disabled={Boolean(error)}
            testID="annotation-save"
          >
            Save
          </Button>
        </View>
      </View>
    </AnchoredSurface>
  );
}

const styles = StyleSheet.create((theme) => ({
  highlight: { color: theme.colors.accent },
  toolbarButton: { ...theme.shadow.sm },
  editor: {
    backgroundColor: theme.colors.surface0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[2],
    gap: theme.spacing[1],
    ...theme.shadow.md,
  },
  input: {
    color: theme.colors.foreground,
    backgroundColor: "transparent",
    borderWidth: 0,
    paddingHorizontal: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    fontSize: theme.fontSize.sm,
    minHeight: INPUT_MIN_HEIGHT,
    maxHeight: INPUT_MAX_HEIGHT,
    textAlignVertical: "top",
    outlineWidth: 0,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[1],
  },
  hint: {
    flex: 1,
    paddingHorizontal: theme.spacing[1],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  error: {
    paddingHorizontal: theme.spacing[1],
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
}));
