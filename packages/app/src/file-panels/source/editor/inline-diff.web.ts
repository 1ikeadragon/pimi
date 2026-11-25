import { ChangeSet, Compartment, Text, type EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { getOriginalDoc, originalDocChangeEffect, unifiedMergeView } from "@codemirror/merge";
import { LINE_BREAK } from "./changes-gutter.web";

/**
 * The inline diff against HEAD: lines removed since HEAD appear as a block above the lines that
 * replaced them, with a Revert button per change. Off, the compartment holds `OFF`.
 *
 * The merge view's own fields take the original text once, when the extension is added; changing
 * the compartment's content while it is on does not reset them. A new HEAD therefore reaches a
 * view that is already on through `originalDocChangeEffect`, the package's path for that.
 */
const inlineDiffCompartment = new Compartment();
const OFF: readonly never[] = [];

function headText(base: string): Text {
  return Text.of(base.split(LINE_BREAK));
}

function isOn(state: EditorState): boolean {
  const current = inlineDiffCompartment.get(state);
  return current !== undefined && current !== OFF;
}

function mergeExtension(base: string, revertLabel: string) {
  return unifiedMergeView({
    original: headText(base),
    // The editor's own change gutter already marks these lines.
    gutter: false,
    mergeControls: (type, action) => {
      // Accepting would rewrite the in-memory copy of HEAD, so the view would stop matching Git.
      // Only reverting a change to its HEAD text is offered.
      if (type === "accept") {
        const placeholder = document.createElement("span");
        placeholder.hidden = true;
        return placeholder;
      }
      const button = document.createElement("button");
      button.name = "reject";
      button.type = "button";
      button.textContent = revertLabel;
      button.addEventListener("mousedown", action);
      return button;
    },
  });
}

/** The extension for the view as it is created: always off; `syncInlineDiff` turns it on. */
export function inlineDiffSlot() {
  return inlineDiffCompartment.of(OFF);
}

/**
 * Brings the view in line with the wanted state. `base` is the file's text at HEAD, or null when
 * there is nothing to compare against, which turns the inline diff off.
 */
export function syncInlineDiff(
  view: EditorView,
  input: { enabled: boolean; base: string | null; revertLabel: string },
): void {
  const { enabled, base, revertLabel } = input;
  const on = isOn(view.state);
  if (!enabled || base === null) {
    if (on) view.dispatch({ effects: inlineDiffCompartment.reconfigure(OFF) });
    return;
  }
  if (!on) {
    view.dispatch({
      effects: inlineDiffCompartment.reconfigure(mergeExtension(base, revertLabel)),
    });
    return;
  }
  const shown = getOriginalDoc(view.state);
  const next = headText(base);
  if (shown.eq(next)) return;
  const replaceAll = ChangeSet.of({ from: 0, to: shown.length, insert: next }, shown.length);
  view.dispatch({ effects: originalDocChangeEffect(view.state, replaceAll) });
}
