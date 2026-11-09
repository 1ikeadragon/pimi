import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { MessageSquarePlus } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { AnnotationSheet } from "@/annotations/sheet";
import {
  addAnnotationToChat,
  useFileAnnotationTarget,
  type AnnotationTarget,
} from "@/annotations/target";
import type { AnnotationCapture } from "@/annotations/model";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { FileFind, FileFindModel } from "../find/index.web";
import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { getLanguageForFile } from "@pimi/highlight";
import { getCM, vim } from "@replit/codemirror-vim";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import type { FileEditorModel } from "./model";
import { usePaneContext } from "@/panels/pane-context";
import { takeRetainedEditor, retainEditor } from "./retained-state.web";
import {
  editorBaseExtensions,
  editorHistory,
  editorTheme,
  type EditorVisualTheme,
} from "./extensions.web";

interface FileEditorViewProps {
  model: FileEditorModel;
  filename: string;
  location: WorkspaceFileLocation;
  navigationRevision: number;
  vimEnabled: boolean;
  theme: EditorVisualTheme;
  onCursorChange(position: { line: number; column: number }): void;
  onVimModeChange(mode: string | null): void;
  /** The editor shows the file's content. */
  onReady(): void;
}

const languageCompartment = new Compartment();
const wrappingCompartment = new Compartment();
const themeCompartment = new Compartment();
const vimCompartment = new Compartment();

/** Markdown is prose, so its paragraphs wrap; code keeps its lines. */
const WRAPPED_EXTENSIONS = new Set(["md", "markdown"]);

function wrappingForFile(filename: string) {
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  return WRAPPED_EXTENSIONS.has(extension) ? EditorView.lineWrapping : [];
}

export function FileEditorView({
  model,
  filename,
  location,
  navigationRevision,
  vimEnabled,
  theme,
  onCursorChange,
  onVimModeChange,
  onReady,
}: FileEditorViewProps) {
  const { serverId, workspaceId, tabId } = usePaneContext();
  const annotationTarget = useFileAnnotationTarget(serverId, workspaceId);
  const [selectedCapture, setSelectedCapture] = useState<AnnotationCapture | null>(null);
  const [annotationDraft, setAnnotationDraft] = useState<{
    capture: AnnotationCapture;
    target: AnnotationTarget;
  } | null>(null);
  const handleAnnotate = useCallback(() => {
    if (selectedCapture && annotationTarget) {
      setAnnotationDraft({ capture: selectedCapture, target: annotationTarget });
    }
  }, [selectedCapture, annotationTarget]);
  const handleCloseAnnotation = useCallback(() => setAnnotationDraft(null), []);
  const handleSaveAnnotation = useCallback(
    async (note: string) => {
      if (!annotationDraft) throw new Error("The annotation is no longer available.");
      await addAnnotationToChat(annotationDraft.target, annotationDraft.capture, note);
    },
    [annotationDraft],
  );
  const retentionKey = JSON.stringify([serverId, workspaceId, tabId, filename]);
  const navigation = JSON.stringify([location.lineStart, location.lineEnd, navigationRevision]);
  const appliedNavigation = useRef<string | null>(null);
  const [find] = useState(() => new FileFindModel());
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const initial = useRef({
    filename,
    model,
    theme,
    vimEnabled,
    content: snapshot.content,
    onReady,
  });
  initial.current = { filename, model, theme, vimEnabled, content: snapshot.content, onReady };
  const onCursorChangeRef = useRef(onCursorChange);
  onCursorChangeRef.current = onCursorChange;

  // Capture scroll before React removes the editor's DOM during pane reparenting.
  useLayoutEffect(() => {
    if (!hostRef.current) return;
    const values = initial.current;
    function reportSelection(state: EditorState) {
      const head = state.selection.main.head;
      const line = state.doc.lineAt(head);
      onCursorChangeRef.current({ line: line.number, column: head - line.from + 1 });
      const { from, to } = state.selection.main;
      const first = state.doc.lineAt(from);
      const last = state.doc.lineAt(to);
      setSelectedCapture(
        from === to || state.selection.ranges.length !== 1
          ? null
          : {
              source: {
                kind: "file",
                serverId,
                workspaceId,
                path: values.filename,
                startLine: first.number,
                startColumn: from - first.from + 1,
                endLine: last.number,
                endColumn: to - last.from + 1,
              },
              quote: state.doc.sliceString(from, to, values.model.getSnapshot().lineSeparator),
            },
      );
    }
    const extensions = [
      vimCompartment.of(values.vimEnabled ? vim() : []),
      find.extension,
      ...editorBaseExtensions(() => void values.model.save()),
      languageCompartment.of(getLanguageForFile(values.filename)?.extension ?? []),
      wrappingCompartment.of(wrappingForFile(values.filename)),
      themeCompartment.of(editorTheme(values.theme)),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !update.transactions.some((tr) => tr.annotation(remoteUpdate))) {
          const { lineSeparator } = values.model.getSnapshot();
          values.model.edit(update.state.doc.sliceString(0, undefined, lineSeparator));
        }
        if (update.selectionSet || update.docChanged) {
          reportSelection(update.state);
        }
      }),
    ];
    const opening = values.model.getSnapshot();
    const restored = takeRetainedEditor(
      retentionKey,
      opening.status === "clean" && !opening.modified ? opening.content : null,
      extensions,
    );
    appliedNavigation.current = restored?.navigation ?? null;
    const view = new EditorView({
      parent: hostRef.current,
      state: restored?.state ?? EditorState.create({ doc: values.content, extensions }),
      scrollTo: restored?.scroll,
    });
    viewRef.current = view;
    reportSelection(view.state);
    values.onReady();
    return () => {
      const saved = values.model.getSnapshot();
      retainEditor(
        retentionKey,
        view,
        saved.status === "clean" && !saved.modified ? saved.content : null,
        appliedNavigation.current,
      );
      view.destroy();
      viewRef.current = null;
    };
  }, [find, model, retentionKey, serverId, workspaceId]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const document = view.state.toText(snapshot.content);
    if (view.state.doc.eq(document)) return;
    const head = Math.min(view.state.selection.main.head, document.length);
    // A disk reload starts a new undo history. Old edits must not be replayed
    // over another writer's content, either here or after a later remount.
    view.dispatch({ effects: editorHistory.reconfigure([]) });
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: document },
      selection: { anchor: head },
      effects: editorHistory.reconfigure(history()),
      annotations: [remoteUpdate.of(true), Transaction.addToHistory.of(false)],
    });
  }, [model, retentionKey, snapshot.content]);

  useEffect(() => {
    const view = viewRef.current;
    // The original line target remains in the tab after the user moves around.
    // Only a new target/revision should override their restored cursor/scroll.
    if (appliedNavigation.current === navigation) return;
    appliedNavigation.current = navigation;
    if (!view || !location.lineStart) return;
    const lineStart = Math.min(location.lineStart, view.state.doc.lines);
    const lineEnd = Math.min(location.lineEnd ?? lineStart, view.state.doc.lines);
    const from = view.state.doc.line(lineStart).from;
    const to = view.state.doc.line(Math.max(lineStart, lineEnd)).to;
    view.dispatch({
      selection: { anchor: from, head: lineEnd > lineStart ? to : from },
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
  }, [location.lineEnd, location.lineStart, model, navigation, retentionKey]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: [
        languageCompartment.reconfigure(getLanguageForFile(filename)?.extension ?? []),
        wrappingCompartment.reconfigure(wrappingForFile(filename)),
      ],
    });
  }, [filename]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: themeCompartment.reconfigure(editorTheme(theme)) });
  }, [theme]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: vimCompartment.reconfigure(vimEnabled ? vim() : []) });
    if (!vimEnabled) {
      onVimModeChange(null);
      return;
    }
    const cm = getCM(view);
    if (!cm) return;
    function handleModeChange(event: { mode?: string }) {
      onVimModeChange((event.mode ?? "normal").toUpperCase());
    }
    cm.on("vim-mode-change", handleModeChange);
    onVimModeChange("NORMAL");
    return () => cm.off("vim-mode-change", handleModeChange);
  }, [model, onVimModeChange, retentionKey, vimEnabled]);

  return (
    <div style={FRAME_STYLE}>
      <div
        ref={hostRef}
        data-pmono=""
        data-testid="file-source-editor"
        aria-label={`Source editor for ${filename}`}
        style={HOST_STYLE}
      />
      <FileFind model={find} editor={viewRef} />
      {selectedCapture && annotationTarget ? (
        <View style={annotationStyles.action}>
          <Button
            leftIcon={MessageSquarePlus}
            accessibilityLabel="Annotate selected code"
            testID="annotate-editor-selection"
            onPress={handleAnnotate}
          >
            Annotate
          </Button>
        </View>
      ) : null}
      {annotationDraft ? (
        <AnnotationSheet
          capture={annotationDraft.capture}
          canSave={annotationTarget?.draftKey === annotationDraft.target.draftKey}
          onClose={handleCloseAnnotation}
          onSave={handleSaveAnnotation}
        />
      ) : null}
    </div>
  );
}

const annotationStyles = StyleSheet.create((theme) => ({
  action: {
    position: "absolute",
    right: theme.spacing[3],
    top: theme.spacing[3],
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing[1],
  },
}));

const remoteUpdate = Annotation.define<boolean>();
const FRAME_STYLE = {
  display: "flex",
  position: "relative",
  flex: 1,
  minHeight: 0,
  minWidth: 0,
} as const;
// CodeMirror's scrollIntoView scrolls every overflowing ancestor and stops at a fixed or sticky
// one. Sticky (with no offsets it lays out like relative) keeps line reveals inside the editor, so
// they don't shift the host around it, such as the compact workspace sheet.
const HOST_STYLE = { flex: 1, minHeight: 0, overflow: "hidden", position: "sticky" } as const;
