import type { AnnotationAttachment } from "./model";

/** One open note editor: the annotation being edited and where its changes go. */
export interface AnnotationEditSession {
  attachment: AnnotationAttachment;
  /** Just created by the toolbar, so cancelling removes it rather than reverting the note. */
  isNew: boolean;
  saveNote(note: string): void;
  remove(): void;
  /** The editor is gone. Unless a press elsewhere dismissed it, focus goes to the composer. */
  onClosed(outcome: AnnotationEditorOutcome): void;
}

/** How a note editor ended: Enter or Save, Escape or Cancel, or a press outside it. */
export type AnnotationEditorOutcome = "saved" | "cancelled" | "dismissed";

/** Opens its anchored editor when the annotation's source is on screen in this surface. */
type AnnotationSource = (session: AnnotationEditSession) => boolean;

const sources = new Set<AnnotationSource>();

/** A chat or file surface offers to host the editor for annotations it is showing. */
export function registerAnnotationSource(source: AnnotationSource): () => void {
  sources.add(source);
  return () => {
    sources.delete(source);
  };
}

/** False when no surface has the source on screen; the caller then edits beside the pill. */
export function openAnnotationAtSource(session: AnnotationEditSession): boolean {
  for (const source of sources) {
    if (source(session)) return true;
  }
  return false;
}
