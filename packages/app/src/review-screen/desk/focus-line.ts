// Pimi. PolyForm-Noncommercial-1.0.0.
import type { ParsedDiffFile } from "@pimi/protocol/messages";

type Hunk = ParsedDiffFile["hunks"][number];

/** The new-side line standing for old-side `line` within one hunk, or null when the hunk lacks it. */
function newLineForOldLine(hunk: Hunk, line: number): number | null {
  let nextOld = hunk.oldStart;
  let nextNew = hunk.newStart;
  for (let index = 0; index < hunk.lines.length; index += 1) {
    const entry = hunk.lines[index];
    if (entry.type === "header") continue;
    if (entry.type !== "add" && nextOld === line) {
      if (entry.type === "context") return nextNew;
      const followed = hunk.lines
        .slice(index + 1)
        .some((later) => later.type === "context" || later.type === "add");
      return followed ? nextNew : Math.max(1, nextNew - 1);
    }
    if (entry.type !== "add") nextOld += 1;
    if (entry.type !== "remove") nextNew += 1;
  }
  return null;
}

/**
 * The new-side line a request to scroll to `line` of `side` lands on. The diff document scrolls
 * by new-side line numbers only; a removed line has none, so it maps to the line that took its
 * place: the next one in its hunk, or the last one before it when nothing follows. Returns null
 * when the file has no such old-side line (the document then scrolls to the file's top).
 */
export function focusLineOnNewSide(
  file: ParsedDiffFile | undefined,
  side: "old" | "new",
  line: number,
): number | null {
  if (side === "new") return line;
  if (!file) return null;
  for (const hunk of file.hunks) {
    const found = newLineForOldLine(hunk, line);
    if (found !== null) return found;
  }
  return null;
}
