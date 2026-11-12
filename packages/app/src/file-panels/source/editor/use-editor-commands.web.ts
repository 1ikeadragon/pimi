import { useId, type RefObject } from "react";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { gotoLine, selectNextOccurrence, selectSelectionMatches } from "@codemirror/search";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";

const EDITOR_ACTIONS = [
  "editor.add-next-occurrence",
  "editor.select-all-occurrences",
  "editor.go-to-line",
] as const;

/**
 * Routes the editor-scoped keys (Cmd/Ctrl+D, Cmd/Ctrl+Shift+L, Ctrl+G) from the shortcut table to
 * CodeMirror's own commands, so they can be rebound and never reach the dictation or Changes
 * bindings. The commands run only while the editor itself holds focus; a key pressed in the Find
 * field is left unhandled.
 */
export function useEditorCommands(editor: RefObject<EditorView | null>, enabled: boolean) {
  const handlerId = `editor-commands:${useId()}`;
  useKeyboardActionHandler({
    handlerId,
    actions: EDITOR_ACTIONS,
    enabled,
    priority: 0,
    handle: (action) => {
      const view = editor.current;
      // Not `view.hasFocus`, which also requires the document to be focused; the keydown already proves it.
      if (!view || view.root.activeElement !== view.contentDOM) return false;
      // A read-only view keeps a single selection range, so there is nothing to add to.
      const multiSelect = view.state.facet(EditorState.allowMultipleSelections);
      switch (action.id) {
        case "editor.add-next-occurrence":
          return multiSelect && selectNextOccurrence(view);
        case "editor.select-all-occurrences":
          return multiSelect && selectSelectionMatches(view);
        case "editor.go-to-line":
          return gotoLine(view);
        default:
          return false;
      }
    },
  });
}
