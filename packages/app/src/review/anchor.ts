// What a note quotes and where it went when the diff changed. A note stores the lines it covers and
// a few lines around them (its anchor). When the diff is re-read, `resolveNote` keeps the note on
// its line while that line still holds the anchored text, finds the text again when it moved, and
// says "detached" when it is gone. Nothing here reads a store; the caller applies the result.
import type { ParsedDiffFile } from "@pimi/protocol/messages";
import type {
  ReviewCommentRelocation,
  ReviewDraftComment,
  ReviewDraftSide,
  ReviewNoteAnchor,
} from "./state";

/** Lines of context kept around a note and sent with a review attachment, either side of its line. */
export const CONTEXT_RADIUS = 3;

interface SideLine {
  number: number;
  content: string;
}

/** The lines one side of a file shows, as one run per hunk: a run is contiguous in the source. */
function sideRuns(file: ParsedDiffFile, side: ReviewDraftSide): SideLine[][] {
  const skip = side === "old" ? "add" : "remove";
  return file.hunks.map((hunk) => {
    const run: SideLine[] = [];
    let next = side === "old" ? hunk.oldStart : hunk.newStart;
    for (const line of hunk.lines) {
      if (line.type === "header" || line.type === skip) continue;
      run.push({ number: next, content: line.content });
      next += 1;
    }
    return run;
  });
}

/** The first line of a note: its own line unless it is a range that starts earlier. */
export function noteStartLine(comment: Pick<ReviewDraftComment, "startLineNumber" | "lineNumber">) {
  const start = comment.startLineNumber;
  return start !== undefined && start < comment.lineNumber ? start : comment.lineNumber;
}

function windowAnchor(run: SideLine[], from: number, length: number): ReviewNoteAnchor {
  return {
    lines: run.slice(from, from + length).map((line) => line.content),
    before: run.slice(Math.max(0, from - CONTEXT_RADIUS), from).map((line) => line.content),
    after: run.slice(from + length, from + length + CONTEXT_RADIUS).map((line) => line.content),
  };
}

/** The anchor of `start..end` on `side`, or null when those lines are not all in one hunk. */
export function captureAnchor(
  file: ParsedDiffFile,
  side: ReviewDraftSide,
  start: number,
  end: number,
): ReviewNoteAnchor | null {
  if (end < start) return null;
  for (const run of sideRuns(file, side)) {
    const from = run.findIndex((line) => line.number === start);
    if (from < 0) continue;
    const length = end - start + 1;
    if (run.length < from + length) continue;
    if (run[from + length - 1].number !== end) continue;
    return windowAnchor(run, from, length);
  }
  return null;
}

/** How many of the anchor's surrounding lines still surround a candidate window. */
function contextScore(anchor: ReviewNoteAnchor, candidate: ReviewNoteAnchor): number {
  let score = 0;
  for (let step = 1; step <= Math.min(anchor.before.length, candidate.before.length); step += 1) {
    if (
      anchor.before[anchor.before.length - step] !==
      candidate.before[candidate.before.length - step]
    )
      break;
    score += 1;
  }
  for (let step = 0; step < Math.min(anchor.after.length, candidate.after.length); step += 1) {
    if (anchor.after[step] !== candidate.after[step]) break;
    score += 1;
  }
  return score;
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

interface Candidate {
  start: number;
  score: number;
}

function findCandidates(
  file: ParsedDiffFile,
  side: ReviewDraftSide,
  anchor: ReviewNoteAnchor,
): Candidate[] {
  const length = anchor.lines.length;
  const found: Candidate[] = [];
  for (const run of sideRuns(file, side)) {
    for (let from = 0; from + length <= run.length; from += 1) {
      const window = windowAnchor(run, from, length);
      if (!sameLines(window.lines, anchor.lines)) continue;
      found.push({ start: run[from].number, score: contextScore(anchor, window) });
    }
  }
  return found;
}

export type NoteResolution =
  /** The note's lines are where they were. `anchor` is set when the note had none and gets one now. */
  | { kind: "placed"; anchor?: ReviewNoteAnchor }
  | { kind: "moved"; filePath: string; startLineNumber: number; lineNumber: number }
  /** The quoted text is not in the diff; the note stays, with what it quoted. */
  | { kind: "detached" };

/** The file a note belongs in: its path, or the file that was renamed from that path. */
export function fileForNote(
  files: ReadonlyMap<string, ParsedDiffFile>,
  filePath: string,
): ParsedDiffFile | null {
  const direct = files.get(filePath);
  if (direct) return direct;
  for (const file of files.values()) {
    if (file.oldPath === filePath) return file;
  }
  return null;
}

/**
 * Where a note stands against the current diff. Text that occurs once moves the note there. Text
 * that occurs several times moves it to the occurrence whose surroundings agree best, nearest the
 * old position among equals, and only when some surrounding line agrees: a repeated line with
 * nothing around it to tell the copies apart is not a place to guess.
 */
export function resolveNote(
  comment: ReviewDraftComment,
  files: ReadonlyMap<string, ParsedDiffFile>,
): NoteResolution {
  const file = fileForNote(files, comment.filePath);
  if (!file) return { kind: "detached" };
  const start = noteStartLine(comment);
  const end = comment.lineNumber;
  const renamed = file.path !== comment.filePath;
  const current = captureAnchor(file, comment.side, start, end);
  if (!comment.anchor) {
    if (!current) return { kind: "detached" };
    return renamed
      ? { kind: "moved", filePath: file.path, startLineNumber: start, lineNumber: end }
      : { kind: "placed", anchor: current };
  }
  if (current && sameLines(current.lines, comment.anchor.lines)) {
    return renamed
      ? { kind: "moved", filePath: file.path, startLineNumber: start, lineNumber: end }
      : { kind: "placed" };
  }
  const candidates = findCandidates(file, comment.side, comment.anchor);
  if (candidates.length === 0) return { kind: "detached" };
  let best = candidates;
  if (candidates.length > 1) {
    const top = Math.max(...candidates.map((candidate) => candidate.score));
    if (top === 0) return { kind: "detached" };
    best = candidates.filter((candidate) => candidate.score === top);
  }
  const nearest = best.reduce((a, b) =>
    Math.abs(b.start - start) < Math.abs(a.start - start) ? b : a,
  );
  return {
    kind: "moved",
    filePath: file.path,
    startLineNumber: nearest.start,
    lineNumber: nearest.start + comment.anchor.lines.length - 1,
  };
}

export interface NotesResolution {
  /** Moves to apply, and anchors to give notes that have none. Empty when nothing changed. */
  relocations: ReviewCommentRelocation[];
  /** Notes whose quoted text is not in the diff. They are kept; the caller lists them. */
  outdated: ReviewDraftComment[];
}

/**
 * Resolves every note against the diff. A note whose file is known but whose patch has not loaded
 * (`pendingPaths`, including the old path of a renamed file) is neither moved nor outdated:
 * claiming it left the diff before its lines are in hand would be a guess.
 */
export function resolveNotes(
  comments: readonly ReviewDraftComment[],
  files: ReadonlyMap<string, ParsedDiffFile>,
  pendingPaths: ReadonlySet<string>,
): NotesResolution {
  const relocations: ReviewCommentRelocation[] = [];
  const outdated: ReviewDraftComment[] = [];
  for (const comment of comments) {
    if (!fileForNote(files, comment.filePath) && pendingPaths.has(comment.filePath)) continue;
    const resolution = resolveNote(comment, files);
    if (resolution.kind === "detached") outdated.push(comment);
    else if (resolution.kind === "moved") {
      const { kind: _kind, ...moves } = resolution;
      relocations.push({ id: comment.id, ...moves });
    } else if (resolution.anchor) relocations.push({ id: comment.id, anchor: resolution.anchor });
  }
  return { relocations, outdated };
}
