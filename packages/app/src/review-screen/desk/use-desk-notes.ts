// Pimi. PolyForm-Noncommercial-1.0.0.
// The user's review notes as the desk shows them: ordered the way they are sent, split into those
// still on the diff and those that left it, with the list's open state and its actions.
import { useCallback, useMemo, useState } from "react";
import type { ParsedDiffFile } from "@pimi/protocol/messages";
import { fileForNote, noteStartLine } from "@/review/anchor";
import {
  useReviewDraftComments,
  useReviewDraftStore,
  type ReviewDraftComment,
} from "@/review/store";
import { focusLineOnNewSide } from "./focus-line";
import { orderNotes } from "./note-annotation";
import type { NotesListProps } from "./notes-panel";

export function useDeskNotes(input: {
  reviewDraftKey: string;
  outdatedNotes: readonly ReviewDraftComment[];
  /** File paths in tree order. */
  paths: readonly string[];
  loadedFiles: ReadonlyMap<string, ParsedDiffFile>;
  jumpTo: (path: string, line: number | null) => void;
  /** The notes list takes the thread dock's slot, so opening it closes the open thread. */
  closeThread: () => void;
}) {
  const { reviewDraftKey, outdatedNotes, paths, loadedFiles, jumpTo, closeThread } = input;
  const [open, setOpen] = useState(false);
  const notes = useReviewDraftComments(reviewDraftKey);
  const orderedNotes = useMemo(() => orderNotes(notes, paths), [notes, paths]);
  const outdatedIds = useMemo(() => new Set(outdatedNotes.map((note) => note.id)), [outdatedNotes]);
  const openNotes = useCallback(() => {
    closeThread();
    setOpen(true);
  }, [closeThread]);
  const closeNotes = useCallback(() => setOpen(false), []);
  const list = useMemo<NotesListProps>(
    () => ({
      notes: orderedNotes.filter((note) => !outdatedIds.has(note.id)),
      outdated: orderedNotes.filter((note) => outdatedIds.has(note.id)),
      onJump: (note) => {
        const file = fileForNote(loadedFiles, note.filePath);
        if (!file) return;
        // An outdated note has no line to go to; its file's top is as near as the diff gets.
        const line = outdatedIds.has(note.id)
          ? null
          : focusLineOnNewSide(file, note.side, noteStartLine(note));
        jumpTo(file.path, line);
      },
      onSave: (id, body) =>
        useReviewDraftStore
          .getState()
          .updateComment({ key: reviewDraftKey, id, updates: { body } }),
      onDelete: (id) => useReviewDraftStore.getState().deleteComment({ key: reviewDraftKey, id }),
    }),
    [jumpTo, loadedFiles, orderedNotes, outdatedIds, reviewDraftKey],
  );
  return { open, openNotes, closeNotes, orderedNotes, outdatedIds, list };
}
