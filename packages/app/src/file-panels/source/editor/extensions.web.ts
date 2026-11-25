import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { createCodeMirrorHighlightStyle, type HighlightStyle } from "@pimi/highlight";
import { Compartment, EditorState } from "@codemirror/state";

export const editorHistory = new Compartment();

/** Width of the change bar; the removed-lines triangle is drawn with borders of the same size. */
const CHANGE_BAR_WIDTH = "4px";

/**
 * How much of the change colour tints a whole line in the inline diff. Chosen, not derived: low
 * enough that syntax colours stay readable on it, near the merge package's own 8% default.
 */
const INLINE_DIFF_LINE_TINT = "10%";
/** The tint on the words that changed inside a line; chosen to stand out over the line tint. */
const INLINE_DIFF_WORD_TINT = "28%";

function tint(color: string, amount: string): string {
  return `color-mix(in srgb, ${color} ${amount}, transparent)`;
}

export interface EditorVisualTheme {
  colorScheme: "light" | "dark";
  background: string;
  foreground: string;
  cursor: string;
  foregroundMuted: string;
  border: string;
  selection: string;
  monoFont: string;
  codeFontSize: number;
  /** Gutter markers for lines added, modified or removed relative to HEAD. */
  changeAdded: string;
  changeModified: string;
  changeDeleted: string;
  syntax: Record<HighlightStyle, string>;
}

export function editorBaseExtensions(onSave: () => void) {
  return [
    lineNumbers(),
    editorHistory.of(history()),
    drawSelection(),
    // Cmd/Ctrl+D and Cmd/Ctrl+Shift+L need more than one selection range.
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    highlightActiveLine(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    keymap.of([
      { key: "Mod-s", preventDefault: true, run: () => (onSave(), true) },
      indentWithTab,
      ...defaultKeymap,
      ...historyKeymap,
    ]),
  ];
}

export function editorTheme(theme: EditorVisualTheme) {
  return [
    EditorView.theme(
      {
        "&": {
          height: "100%",
          backgroundColor: theme.background,
          color: theme.foreground,
          fontFamily: theme.monoFont,
          fontSize: `${theme.codeFontSize}px`,
        },
        ".cm-scroller": {
          overflow: "auto",
          fontFamily: theme.monoFont,
          lineHeight: "1.45",
        },
        ".cm-panels": { backgroundColor: theme.background, color: theme.foreground },
        ".cm-panels-top": { borderBottom: "none" },
        ".cm-searchMatch": { backgroundColor: theme.selection },
        ".cm-searchMatch-selected": {
          backgroundColor: theme.selection,
          outline: `1px solid ${theme.cursor}`,
        },
        ".cm-content": { caretColor: theme.foreground, padding: "16px 0" },
        ".cm-cursor, .cm-dropCursor": { borderLeftColor: theme.cursor },
        ".cm-gutters": {
          backgroundColor: theme.background,
          color: theme.foregroundMuted,
          borderRight: `1px solid ${theme.border}`,
        },
        ".cm-change-gutter": { width: CHANGE_BAR_WIDTH },
        ".cm-change-gutter .cm-gutterElement": { padding: "0", position: "relative" },
        ".cm-change-gutter .cm-change-added": { backgroundColor: theme.changeAdded },
        ".cm-change-gutter .cm-change-modified": { backgroundColor: theme.changeModified },
        ".cm-change-gutter .cm-change-deleted::before": {
          content: '""',
          position: "absolute",
          left: "0",
          top: "0",
          borderTop: `${CHANGE_BAR_WIDTH} solid transparent`,
          borderBottom: `${CHANGE_BAR_WIDTH} solid transparent`,
          borderLeft: `${CHANGE_BAR_WIDTH} solid ${theme.changeDeleted}`,
        },
        // The inline diff (inline-diff.web.ts). The merge package's base theme uses fixed
        // red/green; these rules repeat its selectors so they take over with the theme's colours.
        "&.cm-merge-b .cm-changedLine": {
          backgroundColor: tint(theme.changeAdded, INLINE_DIFF_LINE_TINT),
        },
        "&.cm-merge-b .cm-changedText": {
          background: tint(theme.changeAdded, INLINE_DIFF_WORD_TINT),
        },
        ".cm-deletedChunk": {
          backgroundColor: tint(theme.changeDeleted, INLINE_DIFF_LINE_TINT),
        },
        ".cm-deletedChunk .cm-deletedText": {
          background: tint(theme.changeDeleted, INLINE_DIFF_WORD_TINT),
        },
        ".cm-deletedChunk button[name=reject]": {
          background: theme.background,
          color: theme.foregroundMuted,
          border: `1px solid ${theme.border}`,
          fontFamily: "inherit",
          fontSize: "inherit",
        },
        ".cm-deletedChunk button[name=reject]:hover": { color: theme.foreground },
        ".cm-activeLine": { backgroundColor: "transparent" },
        ".cm-activeLineGutter": { backgroundColor: "transparent", color: theme.foreground },
        "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
          backgroundColor: theme.selection,
        },
        ".cm-selectionBackground, ::selection": {
          backgroundColor: theme.selection,
        },
        "&.cm-focused": { outline: "none" },
      },
      { dark: theme.colorScheme === "dark" },
    ),
    syntaxHighlighting(createCodeMirrorHighlightStyle(theme.syntax)),
  ];
}
