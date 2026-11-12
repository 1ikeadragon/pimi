import type { ParsedDiffFile } from "@pimi/protocol/messages";
import { diffRowContents } from "./model";
import type { DiffCharacterPosition, DiffDocumentModel, DiffSelection } from "./types";

/** Same cap as the editor's Find: the count reads "10000+" past it. */
export const DIFF_FIND_MATCH_LIMIT = 10_000;

export interface DiffFindOptions {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

/** One occurrence of the query. `rowOrdinal` is the row's position inside its file's body. */
export interface DiffFindMatch {
  fileIndex: number;
  rowOrdinal: number;
  cellIndex: number;
  /** UTF-16 offsets into the cell's source text, the same space selections use. */
  start: number;
  end: number;
}

export interface DiffFindResult {
  matches: DiffFindMatch[];
  /** The query is non-empty but is not a valid regular expression. */
  invalid: boolean;
  limited: boolean;
}

export const NO_DIFF_FIND_MATCHES: DiffFindResult = { matches: [], invalid: false, limited: false };

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

function isWordCharacterAt(text: string, index: number): boolean {
  const codePoint = text.codePointAt(index);
  return codePoint !== undefined && WORD_CHARACTER.test(String.fromCodePoint(codePoint));
}

function isWordCharacterBefore(text: string, index: number): boolean {
  if (index <= 0) return false;
  const low = text.charCodeAt(index - 1);
  const isSurrogatePair = low >= 0xdc00 && low <= 0xdfff && index >= 2;
  return isWordCharacterAt(text, isSurrogatePair ? index - 2 : index - 1);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compilePattern(options: DiffFindOptions): RegExp | null {
  try {
    return new RegExp(
      options.regex ? options.query : escapeRegExp(options.query),
      options.caseSensitive ? "g" : "gi",
    );
  } catch {
    // A pattern the user is still typing, like `(`, is expected input; it reports as invalid.
    return null;
  }
}

// A diff's row text is immutable per parsed file object, so keying on the file reuses the work
// across keystrokes and option toggles. A new fetch yields new file objects and drops the entry.
const rowContentsCache = new WeakMap<
  ParsedDiffFile,
  Partial<Record<"unified" | "split", Array<Array<string | null>>>>
>();

function rowContents(file: ParsedDiffFile, layout: "unified" | "split") {
  let byLayout = rowContentsCache.get(file);
  if (!byLayout) {
    byLayout = {};
    rowContentsCache.set(file, byLayout);
  }
  return (byLayout[layout] ??= diffRowContents(file, layout));
}

/** Ranges of the pattern in one line of text, skipping empty matches and, optionally, partial words. */
function cellRanges(text: string, pattern: RegExp, wholeWord: boolean): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  pattern.lastIndex = 0;
  for (let hit = pattern.exec(text); hit; hit = pattern.exec(text)) {
    const start = hit.index;
    const end = start + hit[0].length;
    if (end === start) pattern.lastIndex = end + 1;
    else if (!wholeWord || !(isWordCharacterBefore(text, start) || isWordCharacterAt(text, end)))
      ranges.push([start, end]);
  }
  return ranges;
}

function* searchableCells(
  files: readonly ParsedDiffFile[],
  layout: "unified" | "split",
  collapsedFilePaths: ReadonlySet<string>,
): Generator<{ fileIndex: number; rowOrdinal: number; cellIndex: number; text: string }> {
  for (const [fileIndex, file] of files.entries()) {
    if (collapsedFilePaths.has(file.path)) continue;
    if (file.status === "binary" || file.status === "too_large") continue;
    for (const [rowOrdinal, cells] of rowContents(file, layout).entries()) {
      for (const [cellIndex, text] of cells.entries()) {
        if (text !== null) yield { fileIndex, rowOrdinal, cellIndex, text };
      }
    }
  }
}

/**
 * Every occurrence of the query in the text the diff displays, in document order. Collapsed files
 * and binary or oversized files show no text, so they have no matches. Matching is per line and a
 * split layout shows a context line on both sides, so such a line counts once per side.
 */
export function findInDiff(input: {
  files: readonly ParsedDiffFile[];
  layout: "unified" | "split";
  collapsedFilePaths: ReadonlySet<string>;
  options: DiffFindOptions;
}): DiffFindResult {
  const { options } = input;
  if (options.query === "") return NO_DIFF_FIND_MATCHES;
  const pattern = compilePattern(options);
  if (!pattern) return { matches: [], invalid: true, limited: false };
  const matches: DiffFindMatch[] = [];
  const cells = searchableCells(input.files, input.layout, input.collapsedFilePaths);
  for (const { fileIndex, rowOrdinal, cellIndex, text } of cells) {
    for (const [start, end] of cellRanges(text, pattern, options.wholeWord)) {
      if (matches.length === DIFF_FIND_MATCH_LIMIT) {
        return { matches, invalid: false, limited: true };
      }
      matches.push({ fileIndex, rowOrdinal, cellIndex, start, end });
    }
  }
  return { matches, invalid: false, limited: false };
}

export function diffFindMatchKey(match: DiffFindMatch): string {
  return `${match.fileIndex}:${match.rowOrdinal}:${match.cellIndex}:${match.start}`;
}

/** The model row a match lives on, or null when the model no longer has that row. */
export function diffFindMatchRowIndex(
  model: DiffDocumentModel,
  match: DiffFindMatch,
): number | null {
  const file = model.files[match.fileIndex];
  if (!file || file.isCollapsed) return null;
  const rowIndex = file.rowStart + match.rowOrdinal;
  return rowIndex < file.rowEnd ? rowIndex : null;
}

/** A match as a selection, so highlight rectangles come from the same geometry as selections. */
export function diffFindMatchSelection(
  model: DiffDocumentModel,
  match: DiffFindMatch,
): DiffSelection | null {
  const rowIndex = diffFindMatchRowIndex(model, match);
  if (rowIndex === null) return null;
  const row = model.rows[rowIndex];
  if (row?.kind !== "line") return null;
  const cell = row.cells[match.cellIndex];
  if (!cell) return null;
  const position: Omit<DiffCharacterPosition, "sourceOffset"> = {
    fileIndex: match.fileIndex,
    rowIndex,
    cellIndex: match.cellIndex,
    side: cell.reviewTarget?.side ?? (match.cellIndex === 0 ? "old" : "new"),
  };
  return {
    anchor: { ...position, sourceOffset: match.start },
    focus: { ...position, sourceOffset: match.end },
  };
}

export interface DiffFindRange {
  start: number;
  end: number;
  active: boolean;
}

/** Match ranges per cell, keyed by `diffFindCellKey`, ready for the painter. */
export type DiffFindHighlights = ReadonlyMap<number, readonly DiffFindRange[]>;

export function diffFindCellKey(rowIndex: number, cellIndex: number): number {
  return rowIndex * 2 + cellIndex;
}

export function buildDiffFindHighlights(
  model: DiffDocumentModel,
  matches: readonly DiffFindMatch[],
  activeIndex: number,
): DiffFindHighlights {
  const highlights = new Map<number, DiffFindRange[]>();
  for (const [index, match] of matches.entries()) {
    const rowIndex = diffFindMatchRowIndex(model, match);
    if (rowIndex === null) continue;
    const key = diffFindCellKey(rowIndex, match.cellIndex);
    const ranges = highlights.get(key) ?? [];
    ranges.push({ start: match.start, end: match.end, active: index === activeIndex });
    highlights.set(key, ranges);
  }
  return highlights;
}
