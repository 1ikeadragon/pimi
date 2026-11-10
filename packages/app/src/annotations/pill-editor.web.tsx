import { useCallback, useRef, type RefObject } from "react";
import type { View } from "react-native";
import type { AnnotationEditSession } from "./edit-session";
import { AnnotationNoteEditor } from "./popover.web";

/** The note editor beside the pill, for an annotation whose source is not on screen. */
export function AnnotationPillEditor({
  session,
  pill,
}: {
  session: AnnotationEditSession;
  pill: RefObject<View | null>;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const anchor = useCallback(() => {
    // On web a View's ref is its element.
    const element: unknown = pill.current;
    if (!(element instanceof HTMLElement)) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  }, [pill]);
  return (
    <AnnotationNoteEditor
      session={session}
      anchor={anchor}
      placement="top"
      frameRef={frame}
      onClose={session.onClosed}
    />
  );
}
