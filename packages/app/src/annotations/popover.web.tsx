import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ChevronDown, ChevronUp, MessageSquarePlus } from "lucide-react-native";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { Button } from "@/components/ui/button";
import { computePosition, type Rect } from "@/components/ui/anchor";
import { useOverlayRegistration, type KeyboardInputEvent } from "@/keyboard";
import { getOverlayRoot, useGlobalOverlayLayer } from "@/lib/overlay-root";
import { SPACING } from "@/styles/theme";
import { ANNOTATION_CHARACTER_LIMIT, annotationSourceLabel, type AnnotationCapture } from "./model";

export type AnnotationAnchor = () => Rect | null;

function AnchoredSurface({
  anchor,
  children,
  editor = false,
  layer,
}: {
  anchor: AnnotationAnchor;
  children: ReactNode;
  editor?: boolean;
  layer: number;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const frameStyle = useMemo<CSSProperties>(
    () => ({
      position: "fixed",
      pointerEvents: "auto",
      zIndex: layer,
      // A short note should fit beside code; narrow windows retain an edge gutter.
      width: editor ? 336 : undefined,
      maxWidth: `calc(100vw - ${SPACING[2] * 2}px)`,
      maxHeight: `calc(100dvh - ${SPACING[2] * 2}px)`,
      overflowY: "auto",
      visibility: "hidden",
    }),
    [editor, layer],
  );
  useLayoutEffect(() => {
    const element = surface.current;
    if (!element) return;
    let frame = 0;
    function position() {
      const rect = anchor();
      if (!rect || !element) return;
      const viewport = window.visualViewport;
      const point = computePosition({
        triggerRect: rect,
        contentSize: element.getBoundingClientRect(),
        displayArea: {
          x: viewport?.offsetLeft ?? 0,
          y: viewport?.offsetTop ?? 0,
          width: viewport?.width ?? window.innerWidth,
          height: viewport?.height ?? window.innerHeight,
        },
        placement: "bottom",
        alignment: "start",
        offset: SPACING[2],
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
  }, [anchor]);
  return createPortal(
    <div ref={surface} style={frameStyle}>
      {children}
    </div>,
    getOverlayRoot(),
  );
}

function keepSelection(event: MouseEvent<HTMLDivElement>) {
  event.preventDefault();
}

export function AnnotationAction({
  anchor,
  onPress,
  testID,
  label,
  actionRef,
}: {
  anchor: AnnotationAnchor;
  onPress(): void;
  testID: string;
  label: string;
  actionRef?: RefObject<HTMLDivElement | null>;
}) {
  const layer = useGlobalOverlayLayer("floating", true);
  return (
    <AnchoredSurface anchor={anchor} layer={layer}>
      <div ref={actionRef} onMouseDown={keepSelection}>
        <View style={styles.action}>
          <Button
            size="sm"
            variant="ghost"
            leftIcon={MessageSquarePlus}
            onPress={onPress}
            accessibilityLabel={label}
            testID={testID}
          >
            Annotate
          </Button>
        </View>
      </div>
    </AnchoredSurface>
  );
}

export function AnnotationEditor({
  capture,
  anchor,
  canSave,
  onSave,
  onClose,
}: {
  capture: AnnotationCapture;
  anchor: AnnotationAnchor;
  canSave: boolean;
  onSave(note: string): Promise<void>;
  onClose(): void;
}) {
  const input = useRef<EditingTextInputHandle>(null);
  // The portal is measured before it becomes visible; focus after that layout pass.
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  const [note, setNote] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const layer = useGlobalOverlayLayer("floating", true);
  const quoteTooLong = capture.quote.length > ANNOTATION_CHARACTER_LIMIT;
  let limitError: string | null = null;
  if (quoteTooLong)
    limitError = `Select at most ${ANNOTATION_CHARACTER_LIMIT.toLocaleString()} characters.`;
  else if (note.length > ANNOTATION_CHARACTER_LIMIT)
    limitError = `Shorten your note to ${ANNOTATION_CHARACTER_LIMIT.toLocaleString()} characters or fewer.`;
  const canSubmit = canSave && !saving && Boolean(note.trim()) && !limitError;
  const save = useCallback(async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(note);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add the annotation. Try again.");
    } finally {
      setSaving(false);
    }
  }, [canSubmit, note, onSave, onClose]);
  const handleSave = useCallback(() => void save(), [save]);
  const close = useCallback(() => {
    if (!saving) onClose();
  }, [saving, onClose]);
  const toggleQuote = useCallback(() => setExpanded((value) => !value), []);
  const keyDown = useCallback(
    (event: KeyboardInputEvent) => {
      if (event.isComposing) return false;
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return true;
      }
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && input.current?.isFocused()) {
        event.preventDefault();
        handleSave();
        return true;
      }
      return false;
    },
    [close, handleSave],
  );
  const scope = useOverlayRegistration({
    active: true,
    layer,
    keys: ["Escape", "Enter"],
    onKeyDown: keyDown,
    manageFocus: false,
  });
  return (
    <AnchoredSurface anchor={anchor} editor layer={layer}>
      <View
        ref={scope}
        style={styles.editor}
        role="dialog"
        accessibilityLabel="Annotate selection"
        testID="annotation-editor"
      >
        <View style={styles.context}>
          <View style={styles.sourceRow}>
            <Text numberOfLines={1} style={styles.source}>
              {annotationSourceLabel(capture.source)}
            </Text>
            <Button
              size="sm"
              variant="ghost"
              onPress={toggleQuote}
              leftIcon={expanded ? ChevronUp : ChevronDown}
              accessibilityLabel={expanded ? "Collapse selected text" : "Show full selected text"}
            />
          </View>
          <Text
            selectable
            numberOfLines={expanded ? undefined : 2}
            style={styles.quote}
            testID="annotation-quote"
          >
            {quoteTooLong ? "Selection exceeds the annotation size limit." : capture.quote}
          </Text>
        </View>
        <EditingTextInput
          ref={input}
          multiline
          initialValue={note}
          onChangeText={setNote}
          style={styles.input}
          accessibilityLabel="Annotation note"
          placeholder="Add a note…"
          editable={!saving}
        />
        {!canSave || limitError || error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {!canSave ? "The target chat is no longer available." : (limitError ?? error)}
          </Text>
        ) : null}
        <View style={styles.footer}>
          <Text style={styles.hint}>Adds to your draft</Text>
          <Button size="sm" variant="ghost" onPress={close} disabled={saving}>
            Cancel
          </Button>
          <Button
            size="sm"
            onPress={handleSave}
            disabled={!canSubmit}
            accessibilityLabel="Add annotation to chat"
          >
            {saving ? "Adding…" : "Add to chat"}
          </Button>
        </View>
      </View>
    </AnchoredSurface>
  );
}

const styles = StyleSheet.create((theme) => ({
  action: {
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    ...theme.shadow.sm,
  },
  editor: {
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
    ...theme.shadow.md,
  },
  context: {
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.border,
    paddingLeft: theme.spacing[2],
    alignItems: "flex-start",
    gap: theme.spacing[1],
  },
  sourceRow: { width: "100%", flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  source: { flex: 1, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  quote: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
    width: "100%",
  },
  input: {
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    minHeight: 76,
    maxHeight: 160,
    textAlignVertical: "top",
    outlineColor: theme.colors.accent,
  },
  footer: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  hint: { flex: 1, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
