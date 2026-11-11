import type { EditorView } from "@codemirror/view";
import type { Text } from "@codemirror/state";
import type { DaemonClient } from "@pimi/client/internal/daemon-client";
import type { CodeNavigationResult } from "@pimi/protocol/messages";
import { decodeUtf8 } from "@/utils/decode-utf8";

export type RenameEdit = CodeNavigationResult["edits"][number];

/** Offset of the first character of every line, counting `\r\n`, `\n` and `\r` as breaks. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 13 && text.charCodeAt(index + 1) === 10) index++;
    if (code === 13 || code === 10) starts.push(index + 1);
  }
  return starts;
}

export function groupEditsByPath(edits: RenameEdit[]): Map<string, RenameEdit[]> {
  const byPath = new Map<string, RenameEdit[]>();
  for (const edit of edits) {
    const list = byPath.get(edit.path);
    if (list) list.push(edit);
    else byPath.set(edit.path, [edit]);
  }
  return byPath;
}

/**
 * Applies `edits` (1-based line and column, end exclusive) to `text`. Each edit must still cover
 * `oldName`; if it does not, the text is not the text the edits were computed from.
 */
export function applyRenameEdits(text: string, edits: RenameEdit[], oldName: string): string {
  const starts = lineStarts(text);
  const spans = edits.map((edit) => {
    const from = (starts[edit.line - 1] ?? Number.NaN) + edit.column - 1;
    const to = (starts[edit.endLine - 1] ?? Number.NaN) + edit.endColumn - 1;
    if (!(from >= 0 && to >= from && to <= text.length) || text.slice(from, to) !== oldName) {
      throw new Error("The file changed since the rename was computed.");
    }
    return { from, to, newText: edit.newText };
  });
  spans.sort((a, b) => b.from - a.from);
  let result = text;
  for (const span of spans)
    result = result.slice(0, span.from) + span.newText + result.slice(span.to);
  return result;
}

export async function writeOtherFiles(input: {
  client: DaemonClient;
  cwd: string;
  byPath: Map<string, RenameEdit[]>;
  currentPath: string;
  oldName: string;
}): Promise<void> {
  const written: string[] = [];
  for (const [path, edits] of input.byPath) {
    if (path === input.currentPath) continue;
    const read = await input.client.readFile(input.cwd, path);
    const content = applyRenameEdits(decodeUtf8(read.bytes), edits, input.oldName);
    const outcome = await input.client.writeFile({
      cwd: input.cwd,
      path,
      content,
      expectedModifiedAt: read.modifiedAt,
      ...(read.revision === undefined ? {} : { expectedRevision: read.revision }),
    });
    if (outcome.status !== "written") {
      const done = written.length > 0 ? ` Already renamed in: ${written.join(", ")}.` : "";
      throw new Error(`${path} changed on disk or could not be written; stopped.${done}`);
    }
    written.push(path);
  }
}

/**
 * Checks that the edits still apply to the open document and returns the function that applies
 * them as one transaction, so one undo restores the file. Throws before anything is written when
 * the document changed or no longer matches; the caller runs the returned function last.
 */
export function planEditorReplacement(
  view: EditorView,
  docAtQuery: Text,
  edits: RenameEdit[],
  oldName: string,
): () => void {
  if (!view.state.doc.eq(docAtQuery)) {
    throw new Error("The file changed while renaming; rename again.");
  }
  const text = view.state.doc.toString();
  const next = applyRenameEdits(text, edits, oldName);
  let from = 0;
  while (from < text.length && text[from] === next[from]) from++;
  let to = text.length;
  let nextTo = next.length;
  while (to > from && nextTo > from && text[to - 1] === next[nextTo - 1]) {
    to--;
    nextTo--;
  }
  return () => {
    // The document must still be the one the plan was made from.
    if (!view.state.doc.eq(docAtQuery)) {
      throw new Error("The file changed while renaming; rename again.");
    }
    view.dispatch({
      changes: { from, to, insert: next.slice(from, nextTo) },
      userEvent: "input.rename",
    });
  };
}
