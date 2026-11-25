// Pimi. PolyForm-Noncommercial-1.0.0.
// Moves review notes into a chat's composer, one annotation chip per note. A note leaves the
// review only after its chip is in the draft, so a failure part way leaves every unsent note where
// it was.
import type { NewAnnotation } from "@/annotations/model";
import { AnnotationLimitError } from "@/composer/chips/model";

export interface SendNotesResult {
  sent: number;
  total: number;
  /** Why the loop stopped before the end; null when every note was sent. */
  stopped: { reason: "limit" } | { reason: "error"; error: unknown } | null;
}

export async function sendNotes<Note extends { id: string }>(input: {
  notes: readonly Note[];
  toAnnotation: (note: Note) => NewAnnotation;
  attach: (annotation: NewAnnotation) => Promise<unknown>;
  /** Removes the note from the review. Called once per note, after `attach` resolved. */
  remove: (note: Note) => void;
}): Promise<SendNotesResult> {
  let sent = 0;
  for (const note of input.notes) {
    try {
      await input.attach(input.toAnnotation(note));
    } catch (error) {
      const stopped =
        error instanceof AnnotationLimitError
          ? ({ reason: "limit" } as const)
          : ({ reason: "error", error } as const);
      return { sent, total: input.notes.length, stopped };
    }
    input.remove(note);
    sent += 1;
  }
  return { sent, total: input.notes.length, stopped: null };
}
