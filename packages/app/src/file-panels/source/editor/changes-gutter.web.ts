import { RangeSet, StateEffect, StateField, type EditorState } from "@codemirror/state";
import { GutterMarker, gutter } from "@codemirror/view";
import { diffLines } from "./line-diff";

/**
 * Gutter markers for how the buffer differs from the file at HEAD: a bar on added lines, another on
 * modified lines, and a triangle where lines were removed. The diff runs in the editor on every
 * change to the buffer; no Git process is involved after the base arrives.
 */

/** The text at HEAD; null while unknown, which shows no markers. */
export const setChangesBase = StateEffect.define<string | null>();

class ChangeMarker extends GutterMarker {
  constructor(readonly kind: "added" | "modified" | "deleted") {
    super();
    this.elementClass = `cm-change-${kind}`;
  }

  eq(other: GutterMarker): boolean {
    return other instanceof ChangeMarker && other.kind === this.kind;
  }
}

const ADDED = new ChangeMarker("added");
const MODIFIED = new ChangeMarker("modified");
const DELETED = new ChangeMarker("deleted");

const LINE_BREAK = /\r\n|\r|\n/;

const baseLines = StateField.define<string[] | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setChangesBase))
        return effect.value === null ? null : effect.value.split(LINE_BREAK);
    }
    return value;
  },
});

function computeMarkers(state: EditorState): RangeSet<GutterMarker> {
  const base = state.field(baseLines);
  if (base === null) return RangeSet.empty;
  const doc = state.doc;
  const lines: string[] = [];
  for (const line of doc.iterLines()) lines.push(line);
  const ranges = [];
  for (const hunk of diffLines(base, lines)) {
    const added = hunk.baseFrom === hunk.baseTo;
    const removed = hunk.docFrom === hunk.docTo;
    if (removed) {
      // Nothing of the hunk is in the document; mark the line that now follows it.
      const line = doc.line(Math.min(hunk.docFrom + 1, doc.lines));
      ranges.push(DELETED.range(line.from));
      continue;
    }
    // A replacement edits as many lines as it removes; the lines beyond that are additions.
    const modifiedCount = added
      ? 0
      : Math.min(hunk.baseTo - hunk.baseFrom, hunk.docTo - hunk.docFrom);
    for (let index = hunk.docFrom; index < hunk.docTo; index += 1) {
      const marker = index - hunk.docFrom < modifiedCount ? MODIFIED : ADDED;
      ranges.push(marker.range(doc.line(index + 1).from));
    }
  }
  return RangeSet.of(ranges, true);
}

const markers = StateField.define<RangeSet<GutterMarker>>({
  // The base is unknown until `setChangesBase` arrives, which shows no markers.
  create: () => RangeSet.empty,
  update(value, transaction) {
    const baseChanged = transaction.effects.some((effect) => effect.is(setChangesBase));
    return transaction.docChanged || baseChanged ? computeMarkers(transaction.state) : value;
  },
});

export function changesGutter() {
  return [
    baseLines,
    markers,
    gutter({
      class: "cm-change-gutter",
      markers: (view) => view.state.field(markers),
    }),
  ];
}
