import { useCallback, useRef, useState, type ReactNode, type RefObject } from "react";
import { selectAll } from "@codemirror/commands";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import * as Clipboard from "expo-clipboard";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { useToast } from "@/contexts/toast-api-context";
import { confirmDialog } from "@/utils/confirm-dialog";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { usePaneContext } from "@/panels/pane-context";
import { useSessionStore } from "@/stores/session-store";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { openWorkspaceFileLocation } from "@/workspace/file-open/open-location";
import { groupEditsByPath, replaceInEditor, writeOtherFiles } from "./rename-edits";
import {
  NavigationResultsPanel,
  providerLabel,
  type NavigationPanelState,
} from "./results-panel.web";

type QueryKind = "definition" | "references";

interface ClickTarget {
  /** The identifier under the pointer, with its 1-based position. */
  symbol: { text: string; line: number; column: number } | null;
  /** The selected text, or the identifier when nothing is selected. */
  searchText: string;
}

const MAX_SYMBOL_LENGTH = 256;
const MAX_LABEL_LENGTH = 28;

function eventPoint(event: unknown): { x: number; y: number } | null {
  if (typeof event !== "object" || event === null) return null;
  const native = Reflect.get(event, "nativeEvent");
  const source = typeof native === "object" && native !== null ? native : event;
  const x = Reflect.get(source, "clientX");
  const y = Reflect.get(source, "clientY");
  return typeof x === "number" && typeof y === "number" ? { x, y } : null;
}

/** Reads what was right-clicked, and selects the identifier when the click was outside the selection. */
function captureTarget(view: EditorView, event: unknown): ClickTarget {
  const point = eventPoint(event);
  const position = point ? view.posAtCoords(point) : null;
  const state = view.state;
  const selection = state.selection.main;
  const insideSelection =
    position !== null && !selection.empty && position >= selection.from && position <= selection.to;
  const word = position === null ? null : state.wordAt(position);
  if (!insideSelection && word) {
    view.dispatch({ selection: EditorSelection.single(word.from, word.to) });
  }
  const text = word ? state.sliceDoc(word.from, word.to) : "";
  const line = word ? state.doc.lineAt(word.from) : null;
  const symbol =
    word && line && text.length > 0 && text.length <= MAX_SYMBOL_LENGTH
      ? { text, line: line.number, column: word.from - line.from + 1 }
      : null;
  const selected = view.state.selection.main;
  const selectedText = selected.empty ? "" : view.state.sliceDoc(selected.from, selected.to);
  const searchText = insideSelection || !word ? selectedText : text;
  return { symbol, searchText: searchText.trim().replace(/\s+/g, " ").slice(0, 512) };
}

const TYPESCRIPT_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/i;

function isTypeScriptFileName(filename: string): boolean {
  return TYPESCRIPT_EXTENSION.test(filename);
}

function validateIdentifier(value: string): string | null {
  return /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(value) ? null : "Use a valid identifier.";
}

function shortened(text: string): string {
  return text.length > MAX_LABEL_LENGTH ? `${text.slice(0, MAX_LABEL_LENGTH)}…` : text;
}

/**
 * The editor's right-click menu: navigation by name (or by TypeScript when that answers), codebase
 * search, and the clipboard commands that Electron's default menu would otherwise provide.
 */
export function CodeNavigation({
  editor,
  filename,
  readOnly,
  onSave,
  getUnsavedContent,
  children,
}: {
  editor: RefObject<EditorView | null>;
  filename: string;
  readOnly: boolean;
  /** Saves the edited file; a rename writes every other file, so this one is saved with them. */
  onSave?: () => void;
  /** The buffer when it differs from disk; a semantic provider must see what the user sees. */
  getUnsavedContent?: () => string | null;
  children: ReactNode;
}) {
  const { serverId, workspaceId } = usePaneContext();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const toast = useToast();
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  const [renaming, setRenaming] = useState<NonNullable<ClickTarget["symbol"]> | null>(null);
  const [target, setTarget] = useState<ClickTarget>({ symbol: null, searchText: "" });
  const [panel, setPanel] = useState<NavigationPanelState | null>(null);
  const sequence = useRef(0);

  const handleContextMenu = useCallback(
    (event: unknown) => {
      const view = editor.current;
      if (view) setTarget(captureTarget(view, event));
    },
    [editor],
  );

  const jumpTo = useCallback(
    (location: { path: string; line: number; column: number }) => {
      const view = editor.current;
      if (view && location.path === filename) {
        const line = view.state.doc.line(Math.min(location.line, view.state.doc.lines));
        const from = Math.min(line.from + location.column - 1, line.to);
        view.dispatch({
          selection: EditorSelection.single(from),
          effects: EditorView.scrollIntoView(from, { y: "center" }),
        });
        view.focus();
        return;
      }
      openWorkspaceFileLocation({
        serverId,
        workspaceId,
        location: { path: location.path, lineStart: location.line },
      });
    },
    [editor, filename, serverId, workspaceId],
  );

  const runQuery = useCallback(
    async (kind: QueryKind) => {
      const symbol = target.symbol;
      if (!symbol || !client) return;
      const token = ++sequence.current;
      const title = `${kind === "definition" ? "Definition of" : "References to"} “${shortened(symbol.text)}”`;
      setPanel({ status: "loading", title });
      try {
        const unsaved = getUnsavedContent?.() ?? undefined;
        const result = await client.queryCodeNavigation({
          workspaceId,
          path: filename,
          line: symbol.line,
          column: symbol.column,
          symbol: symbol.text,
          kind,
          ...(unsaved === undefined ? {} : { content: unsaved }),
        });
        if (token !== sequence.current) return;
        if (kind === "definition" && result.results.length === 1) {
          setPanel(null);
          toast.show(`Definition · ${providerLabel(result.provider)}`);
          jumpTo(result.results[0]);
          return;
        }
        setPanel({
          status: "results",
          title,
          result,
          empty: kind === "definition" ? "No definition found." : "No references found.",
        });
      } catch (error) {
        if (token !== sequence.current) return;
        setPanel({
          status: "error",
          title,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [client, filename, getUnsavedContent, jumpTo, target.symbol, toast, workspaceId],
  );

  const searchCodebase = useCallback(() => {
    useKeyboardShortcutsStore.getState().setCommandCenterOpen(true, "code", target.searchText);
  }, [target.searchText]);

  const copy = useCallback(async () => {
    const view = editor.current;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    if (from === to) return;
    await Clipboard.setStringAsync(view.state.sliceDoc(from, to));
    view.focus();
  }, [editor]);

  const cut = useCallback(async () => {
    const view = editor.current;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    if (from === to) return;
    await Clipboard.setStringAsync(view.state.sliceDoc(from, to));
    view.dispatch({
      changes: { from, to },
      selection: EditorSelection.single(from),
      userEvent: "delete.cut",
    });
    view.focus();
  }, [editor]);

  const paste = useCallback(async () => {
    const view = editor.current;
    if (!view) return;
    const text = await Clipboard.getStringAsync();
    if (!text) return;
    view.dispatch(view.state.replaceSelection(text), {
      userEvent: "input.paste",
      scrollIntoView: true,
    });
    view.focus();
  }, [editor]);

  const handleSelectAll = useCallback(() => {
    const view = editor.current;
    if (!view) return;
    selectAll(view);
    view.focus();
  }, [editor]);

  const startRename = useCallback(() => setRenaming(target.symbol), [target.symbol]);
  const closeRename = useCallback(() => setRenaming(null), []);

  const submitRename = useCallback(
    async (newName: string) => {
      const view = editor.current;
      const symbol = renaming;
      if (!view || !client || !cwd || !symbol) throw new Error("The editor is not ready.");
      const docAtQuery = view.state.doc;
      const unsaved = getUnsavedContent?.() ?? undefined;
      const result = await client.queryCodeNavigation({
        workspaceId,
        path: filename,
        line: symbol.line,
        column: symbol.column,
        symbol: symbol.text,
        kind: "rename",
        newName,
        ...(unsaved === undefined ? {} : { content: unsaved }),
      });
      const byPath = groupEditsByPath(result.edits);
      if (byPath.size === 0) throw new Error("Nothing to rename.");
      const summary = [...byPath.entries()]
        .map(([path, edits]) => `${path}  (${edits.length})`)
        .join("\n");
      const confirmed = await confirmDialog({
        title: `Rename “${symbol.text}” to “${newName}”?`,
        message: `${result.edits.length} occurrences in ${byPath.size} ${
          byPath.size === 1 ? "file" : "files"
        }:\n${summary}`,
        confirmLabel: "Rename",
      });
      if (!confirmed) return;

      // Every other file is rewritten first, each over the version that was read: a file that
      // changed on disk refuses the write, and the current file is left untouched.
      await writeOtherFiles({ client, cwd, byPath, currentPath: filename, oldName: symbol.text });
      const own = byPath.get(filename);
      if (own) {
        replaceInEditor(view, docAtQuery, own, symbol.text);
        onSave?.();
      }
      toast.show(
        `Renamed ${result.edits.length} occurrences in ${byPath.size} ${
          byPath.size === 1 ? "file" : "files"
        } · TypeScript`,
      );
    },
    [client, cwd, editor, filename, getUnsavedContent, onSave, renaming, toast, workspaceId],
  );

  const goToDefinition = useCallback(() => void runQuery("definition"), [runQuery]);
  const findReferences = useCallback(() => void runQuery("references"), [runQuery]);
  const handleCut = useCallback(() => void cut(), [cut]);
  const handleCopy = useCallback(() => void copy(), [copy]);
  const handlePaste = useCallback(() => void paste(), [paste]);
  const canRename = !readOnly && isTypeScriptFileName(filename);
  const hasSelection = target.searchText.length > 0;
  const closePanel = useCallback(() => {
    sequence.current++;
    setPanel(null);
  }, []);

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger contextOnly style={TRIGGER_STYLE} onContextMenu={handleContextMenu}>
          {children}
        </ContextMenuTrigger>
        <ContextMenuContent minWidth={220} testID="editor-context-menu">
          <ContextMenuItem
            disabled={!target.symbol}
            onSelect={goToDefinition}
            testID="editor-menu-definition"
          >
            Go to Definition
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!target.symbol}
            onSelect={findReferences}
            testID="editor-menu-references"
          >
            Find References
          </ContextMenuItem>
          {canRename ? (
            <ContextMenuItem
              disabled={!target.symbol}
              onSelect={startRename}
              testID="editor-menu-rename"
            >
              Rename Symbol…
            </ContextMenuItem>
          ) : null}
          <ContextMenuItem
            disabled={!hasSelection}
            onSelect={searchCodebase}
            testID="editor-menu-search"
          >
            {hasSelection
              ? `Search Codebase for “${shortened(target.searchText)}”`
              : "Search Codebase"}
          </ContextMenuItem>
          <ContextMenuSeparator />
          {readOnly ? null : (
            <ContextMenuItem disabled={!hasSelection} onSelect={handleCut} testID="editor-menu-cut">
              Cut
            </ContextMenuItem>
          )}
          <ContextMenuItem disabled={!hasSelection} onSelect={handleCopy} testID="editor-menu-copy">
            Copy
          </ContextMenuItem>
          {readOnly ? null : (
            <ContextMenuItem onSelect={handlePaste} testID="editor-menu-paste">
              Paste
            </ContextMenuItem>
          )}
          <ContextMenuItem onSelect={handleSelectAll} testID="editor-menu-select-all">
            Select All
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <AdaptiveRenameModal
        visible={renaming !== null}
        title={`Rename “${renaming?.text ?? ""}”`}
        initialValue={renaming?.text ?? ""}
        submitLabel="Rename"
        onClose={closeRename}
        onSubmit={submitRename}
        validate={validateIdentifier}
        maxLength={256}
        testID="editor-rename"
      />
      {panel ? (
        <NavigationResultsPanel state={panel} onSelect={jumpTo} onClose={closePanel} />
      ) : null}
    </>
  );
}

// The trigger replaces the editor host in the frame's flex row.
const TRIGGER_STYLE = { flex: 1, minHeight: 0, minWidth: 0, flexDirection: "row" } as const;
