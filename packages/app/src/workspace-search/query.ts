import {
  createWorkspaceSearchRegExp,
  expandReplacement,
  type WorkspaceSearchPattern,
} from "@pimi/protocol/search/workspace-search-pattern";
import type { WorkspaceSearchMatch } from "@pimi/protocol/workspace-search";

export interface WorkspaceSearchForm extends WorkspaceSearchPattern {
  replacement: string;
  include: string;
  exclude: string;
  /** false also searches files that .gitignore excludes. */
  useIgnoreFiles: boolean;
}

export const INITIAL_SEARCH_FORM: WorkspaceSearchForm = {
  query: "",
  replacement: "",
  isRegex: false,
  matchCase: false,
  wholeWord: false,
  include: "",
  exclude: "",
  useIgnoreFiles: true,
};

/** What a search is for. The replacement text is not part of it: changing that must not search again. */
export function searchKeyOf(form: WorkspaceSearchForm): string {
  return JSON.stringify([
    form.query,
    form.isRegex,
    form.matchCase,
    form.wholeWord,
    form.include,
    form.exclude,
    form.useIgnoreFiles,
  ]);
}

/** The comma-separated glob fields the daemon expands; empty entries drop out. */
export function splitGlobList(text: string): string[] {
  return text
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Occurrences the search located in one result line; a line it could not locate counts as none. */
export function locatedOccurrences(match: WorkspaceSearchMatch): number {
  return match.ranges.length;
}

/** 0-based column of an occurrence in the full line. */
export function occurrenceColumn(match: WorkspaceSearchMatch, rangeIndex: number): number {
  return match.previewOffset + match.ranges[rangeIndex][0];
}

export interface ReplacePreviewSegment {
  kind: "text" | "removed" | "added";
  text: string;
}

/**
 * A result line as it reads after the replacement: untouched text, each match struck, and what
 * replaces it. Runs the same pattern code as the daemon's replace.
 */
export function buildReplacePreview(
  match: WorkspaceSearchMatch,
  form: WorkspaceSearchForm,
): ReplacePreviewSegment[] {
  const global = createWorkspaceSearchRegExp(form);
  const sticky = global ? new RegExp(global.source, `${global.flags.replace("g", "")}y`) : null;
  const segments: ReplacePreviewSegment[] = [];
  let cursor = 0;
  for (const [start, end] of match.ranges) {
    if (start < cursor) continue;
    if (start > cursor) segments.push({ kind: "text", text: match.preview.slice(cursor, start) });
    segments.push({ kind: "removed", text: match.preview.slice(start, end) });
    segments.push({ kind: "added", text: replacementAt(sticky, match.preview, start, end, form) });
    cursor = end;
  }
  if (cursor < match.preview.length) {
    segments.push({ kind: "text", text: match.preview.slice(cursor) });
  }
  return segments;
}

function replacementAt(
  sticky: RegExp | null,
  line: string,
  start: number,
  end: number,
  form: WorkspaceSearchForm,
): string {
  if (!sticky) return form.replacement;
  sticky.lastIndex = start;
  const found = sticky.exec(line);
  // The line shown is a window of the real one; where the window cuts a lookbehind or anchor the
  // match may not reproduce, and the replacement is shown without expanding its groups.
  if (!found || found[0].length !== end - start) return form.replacement;
  return expandReplacement(found, form.replacement, form.isRegex);
}
