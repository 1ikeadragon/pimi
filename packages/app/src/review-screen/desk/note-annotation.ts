// Pimi. PolyForm-Noncommercial-1.0.0.
// A review note as a composer annotation: the lines it covers, with +/- markers so the agent can
// tell added, removed and unchanged lines apart, and where it came from.
import type { ParsedDiffFile } from "@pimi/protocol/messages";
import type { NewAnnotation } from "@/annotations/model";
import { noteStartLine } from "@/review/anchor";
import type { ReviewDraftComment } from "@/review/state";

/** Marks a note whose quoted text is not in the diff any more; the quote is what it stored. */
export const OUTDATED_QUOTE_MARKER = "(no longer in the diff)";

const LINE_MARKER = { add: "+", remove: "-", context: " " } as const;

/** The diff's lines of `side` numbered `start..end`, each with its marker: `+`, `-` or a space. */
export function markedQuote(
  file: ParsedDiffFile,
  side: "old" | "new",
  start: number,
  end: number,
): string | null {
  const skip = side === "old" ? "add" : "remove";
  const lines: string[] = [];
  for (const hunk of file.hunks) {
    let next = side === "old" ? hunk.oldStart : hunk.newStart;
    for (const line of hunk.lines) {
      if (line.type === "header" || line.type === skip) continue;
      if (next >= start && next <= end) {
        lines.push(`${LINE_MARKER[line.type]}${line.content}`);
      }
      next += 1;
    }
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

export function noteToAnnotation(input: {
  note: ReviewDraftComment;
  /** The file as the diff has it now; null when it is not in the diff. */
  file: ParsedDiffFile | null;
  /** The note's quoted text is not in the diff (see `resolveNotes`): send what it stored. */
  outdated: boolean;
  serverId: string;
  cwd: string;
  baseRef: string | null;
  id: string;
}): NewAnnotation {
  const { note, file } = input;
  const start = noteStartLine(note);
  const live =
    file && !input.outdated ? markedQuote(file, note.side, start, note.lineNumber) : null;
  // A note that left the diff sends what it stored, unmarked: the anchor holds text, not line kinds.
  const stored = note.anchor ? note.anchor.lines.join("\n") : "";
  const quote = live ?? [OUTDATED_QUOTE_MARKER, stored].filter(Boolean).join("\n");
  return {
    kind: "annotation",
    id: input.id,
    source: {
      kind: "diff",
      serverId: input.serverId,
      cwd: input.cwd,
      path: note.filePath,
      side: note.side,
      startLine: start,
      endLine: note.lineNumber,
      baseRef: input.baseRef,
    },
    quote,
    note: note.body,
  };
}

/** Tree order of files, then line, then old side before new: how the agent reads the diff. */
export function orderNotes(
  notes: readonly ReviewDraftComment[],
  pathOrder: readonly string[],
): ReviewDraftComment[] {
  const rank = new Map(pathOrder.map((path, index) => [path, index]));
  const rankOf = (path: string) => rank.get(path) ?? pathOrder.length;
  return [...notes].sort(
    (a, b) =>
      rankOf(a.filePath) - rankOf(b.filePath) ||
      a.filePath.localeCompare(b.filePath) ||
      noteStartLine(a) - noteStartLine(b) ||
      a.lineNumber - b.lineNumber ||
      Number(a.side === "new") - Number(b.side === "new"),
  );
}
