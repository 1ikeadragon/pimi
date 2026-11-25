// Pimi. PolyForm-Noncommercial-1.0.0.
// The Files tab. A file tree beside the shared `DiffDocument`, fed by a `FilesModel`: a pull
// request's file list and on-demand patches, or a worktree's live checkout diff (see
// `desk/use-files-model.ts`). Small changes scroll as one document; large ones show a file at a
// time. Forge threads draw under their lines and the user's own line notes leave through "Ask in
// chat" (`desk/ask-in-chat.tsx`).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SearchField } from "@/components/ui/search-field";
import { DiffDocument } from "@/git/diff-document";
import { DiffDocumentWorkspaceCacheProvider } from "@/git/diff-document/workspace-cache";
import { ReviewCommentSheet } from "@/review";
import type { ChangeRequestSource, CheckoutSource, ReviewDeskProps, ReviewSource } from "./types";
import { AskInChat } from "./desk/ask-in-chat";
import { useDeskCopy } from "./desk/copy";
import { FileTree } from "./desk/file-tree";
import { focusLineOnNewSide } from "./desk/focus-line";
import { FilesBar } from "./desk/files-bar";
import { NotesPanel, NotesSheet } from "./desk/notes-panel";
import { ThreadPanel, ThreadSheet, THREAD_PANEL_DOCK_MIN_WIDTH } from "./desk/thread-panel";
import { Chip, DetachedThreads } from "./desk/ui";
import {
  useDeskDisplay,
  useDeskFilter,
  useDeskKeyboard,
  useDeskViewed,
} from "./desk/use-desk-state";
import {
  resolveActivePath,
  useChangeRequestFilesModel,
  useCheckoutFilesModel,
  type FilesModel,
  type FilesView,
} from "./desk/use-files-model";
import type { ForgeThread } from "./desk/use-desk-data";
import { useDeskNotes } from "./desk/use-desk-notes";
import { useReviewMarkers } from "./desk/use-review-markers";
import { useLineCommentPoster } from "./desk/use-line-comment";
import { Notice } from "./notice";

export function ReviewDesk({ source, focus }: ReviewDeskProps) {
  return (
    <DiffDocumentWorkspaceCacheProvider>
      {source.kind === "change_request" ? (
        <ChangeRequestFiles source={source} focus={focus} />
      ) : (
        <CheckoutFiles source={source} focus={focus} />
      )}
    </DiffDocumentWorkspaceCacheProvider>
  );
}

function ChangeRequestFiles({
  source,
  focus,
}: {
  source: ChangeRequestSource;
  focus: ReviewDeskProps["focus"];
}) {
  const view = useFilesView(focus);
  const model = useChangeRequestFilesModel(source, view.input);
  return <FilesDesk source={source} model={model} view={view} focus={focus} />;
}

function CheckoutFiles({
  source,
  focus,
}: {
  source: CheckoutSource;
  focus: ReviewDeskProps["focus"];
}) {
  const view = useFilesView(focus);
  const model = useCheckoutFilesModel(source, view.input);
  return <FilesDesk source={source} model={model} view={view} focus={focus} />;
}

interface FocusTarget {
  path: string;
  line: number | null;
  seq: number;
}

/** Which file is active, which one the document scrolls to and when, and the user's mode choice. */
function useFilesView(focus: ReviewDeskProps["focus"]) {
  const [activePath, setActivePath] = useState<string>(() => focus?.path ?? "");
  const [singleOverride, setSingleOverride] = useState(false);
  const [target, setTarget] = useState<FocusTarget | null>(null);
  const [reveal, setReveal] = useState<{ path: string; seq: number } | null>(null);
  const seqRef = useRef(0);
  const jumpTo = useCallback((path: string, line: number | null, fromTree = false) => {
    seqRef.current += 1;
    setActivePath(path);
    setTarget({ path, line, seq: seqRef.current });
    if (!fromTree) setReveal({ path, seq: seqRef.current });
  }, []);
  const moveTo = useCallback((path: string) => jumpTo(path, null), [jumpTo]);
  const selectInTree = useCallback((path: string) => jumpTo(path, null, true), [jumpTo]);
  const toggleMode = useCallback(() => setSingleOverride((current) => !current), []);
  const input = useMemo<FilesView>(
    () => ({ activePath, singleOverride }),
    [activePath, singleOverride],
  );
  return { input, target, reveal, jumpTo, moveTo, selectInTree, toggleMode };
}

type FilesViewState = ReturnType<typeof useFilesView>;

function FilesDesk({
  source,
  model,
  view,
  focus,
}: {
  source: ReviewSource;
  model: FilesModel;
  view: FilesViewState;
  focus: ReviewDeskProps["focus"];
}) {
  const copy = useDeskCopy();
  const { status } = model;
  if (status.state === "loading") {
    return <Notice text={copy.loadingFiles} busy testID="review-desk-notice" />;
  }
  if (status.state === "error") {
    return (
      <Notice
        text={`${copy.loadError} ${status.message}`}
        onRetry={status.retry}
        testID="review-desk-notice"
      />
    );
  }
  if (status.state === "empty") {
    return (
      <Notice
        text={model.kind === "checkout" ? copy.noChanges : copy.noFiles}
        testID="review-desk-notice"
      />
    );
  }
  return <ReadyDesk source={source} model={model} view={view} focus={focus} />;
}

function ReadyDesk({
  source,
  model,
  view,
  focus,
}: {
  source: ReviewSource;
  model: FilesModel;
  view: FilesViewState;
  focus: ReviewDeskProps["focus"];
}) {
  const copy = useDeskCopy();
  const display = useDeskDisplay();
  const { isCompact } = display;
  const { stubs, loadedFiles, mode, eligibleMode } = model;
  const paths = useMemo(() => stubs.map((file) => file.path), [stubs]);
  const activePath = resolveActivePath(paths, view.input.activePath);
  const { target, reveal, jumpTo, moveTo, selectInTree } = view;

  // A thread or check asked to move: once per request, whichever tab it came from.
  const nonce = focus?.nonce;
  useEffect(() => {
    if (focus && paths.includes(focus.path)) {
      const line =
        focus.line !== null && focus.side
          ? focusLineOnNewSide(loadedFiles.get(focus.path), focus.side, focus.line)
          : focus.line;
      jumpTo(focus.path, line);
    }
    // Keyed on the request's nonce: repeating the same target must still fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);

  const postLineComment = useLineCommentPoster(model);
  const markers = useReviewMarkers({
    reviewDraftKey: model.draftKey,
    threads: model.threads.threads,
    loadedFiles,
    stubs,
    postLineComment,
  });
  const unresolvedByPath = useMemo(() => {
    const out = new Map<string, number>();
    for (const [path, count] of model.threads.counts) out.set(path, count.unresolved);
    return out;
  }, [model.threads.counts]);

  const { viewedPaths, toggleViewed } = useDeskViewed(model.reviewKey, paths, model.viewedKeyFor);
  const filter = useDeskFilter({ stubs, viewedPaths, unresolvedByPath });
  useDeskKeyboard({ paths, activePath, onMove: moveTo, onToggleViewed: toggleViewed });

  // The document scrolls once per request id. Re-issue the request when the target file's patch
  // lands and again once every patch is in, so a line target resolves after layout settles.
  const targetLoaded = target ? loadedFiles.has(target.path) : false;
  const settled = mode === "single" || loadedFiles.size === paths.length;
  const [collapsedPaths, setCollapsedPaths] = useState<string[]>([]);
  const documentMode = useMemo(() => {
    const requestBits = (targetLoaded ? 1 : 0) + (settled ? 2 : 0);
    return {
      kind: "working" as const,
      reviewActions: markers.reviewActions,
      focusPath: mode === "single" ? activePath : target?.path,
      focusLine: targetLoaded ? (target?.line ?? undefined) : undefined,
      focusRequestId: target ? target.seq * 4 + requestBits : undefined,
    };
  }, [activePath, markers.reviewActions, mode, settled, target, targetLoaded]);
  const collapseState = useMemo(
    () => ({ paths: collapsedPaths, onChange: setCollapsedPaths }),
    [collapsedPaths],
  );

  const [treeOpen, setTreeOpen] = useState(false);
  const showTree = useCallback(() => setTreeOpen(true), []);
  const selectFromTree = useCallback(
    (path: string) => {
      selectInTree(path);
      setTreeOpen(false);
    },
    [selectInTree],
  );
  const { openThread, onOpenThread, onCloseThread } = markers;
  const deskNotes = useDeskNotes({
    reviewDraftKey: markers.reviewDraftKey,
    outdatedNotes: markers.outdatedNotes,
    paths,
    loadedFiles,
    jumpTo,
    closeThread: onCloseThread,
  });
  const { closeNotes } = deskNotes;
  const openDetached = useCallback(
    (path: string, id: string) => {
      moveTo(path);
      closeNotes();
      onOpenThread(id);
    },
    [closeNotes, moveTo, onOpenThread],
  );
  // The panel resizes the diff; ask for the thread's line again once it is open so it stays in view.
  const openThreadId = openThread?.id ?? null;
  useEffect(() => {
    if (openThread?.line) jumpTo(openThread.path, openThread.line, true);
    // Keyed on the id: a thread's data refreshing must not scroll the document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openThreadId]);
  const [deskWidth, setDeskWidth] = useState(0);
  const onDeskLayout = useCallback(
    (event: LayoutChangeEvent) => setDeskWidth(event.nativeEvent.layout.width),
    [],
  );
  const docked = !isCompact && deskWidth >= THREAD_PANEL_DOCK_MIN_WIDTH;

  const treePane = (
    <View style={isCompact ? styles.treeFull : styles.tree} testID="review-desk-tree-pane">
      <View style={styles.filterBox}>
        <SearchField
          value={filter.filter}
          onChangeText={filter.setFilter}
          placeholder={copy.filterPlaceholder}
          clearAccessibilityLabel={copy.filterClear}
          testID="review-desk-filter"
        />
        <View style={styles.chips}>
          <Chip
            label={copy.unviewedOnly}
            active={filter.unviewedOnly}
            onToggle={filter.toggleUnviewed}
          />
          <Chip
            label={copy.withThreads}
            active={filter.threadsOnly}
            onToggle={filter.toggleThreads}
          />
        </View>
      </View>
      <FileTree
        files={filter.treeFiles}
        activePath={activePath}
        unresolvedByPath={unresolvedByPath}
        viewedPaths={viewedPaths}
        onSelectFile={selectFromTree}
        onToggleViewed={toggleViewed}
        reveal={reveal}
      />
    </View>
  );

  if (isCompact && treeOpen) return <View style={styles.desk}>{treePane}</View>;
  return (
    <View style={styles.desk} testID="review-desk" onLayout={onDeskLayout}>
      {isCompact ? null : treePane}
      <View style={styles.main}>
        <FilesBar
          activePath={activePath}
          viewedLabel={copy.viewed(viewedPaths.size, paths.length)}
          mode={mode}
          canToggleMode={eligibleMode === "continuous"}
          showFilesButton={isCompact}
          canSplit={display.canSplit}
          layout={display.layout}
          onShowFiles={showTree}
          onToggleMode={view.toggleMode}
          onToggleLayout={display.toggleLayout}
        />
        {eligibleMode === "single" ? (
          <Text style={styles.note}>{copy.singleFileNote(model.totalFiles)}</Text>
        ) : null}
        {model.threads.error ? <Text style={styles.note}>{copy.threadsFailed}</Text> : null}
        {model.diffTooLarge ? <Text style={styles.note}>{copy.diffTooLarge}</Text> : null}
        <DetachedThreads detached={markers.detached} onOpen={openDetached} />
        <View style={styles.document} testID="review-desk-document">
          <DeskBody
            model={model}
            display={display.displayPreferences}
            documentMode={documentMode}
            collapseState={collapseState}
            activePath={activePath}
          />
        </View>
        <AskInChat
          source={source}
          reviewDraftKey={markers.reviewDraftKey}
          notes={deskNotes.orderedNotes}
          outdatedIds={deskNotes.outdatedIds}
          loadedFiles={loadedFiles}
          baseRef={model.baseRef}
          onViewNotes={deskNotes.openNotes}
        />
      </View>
      <SideSlot
        thread={openThread}
        onCloseThread={onCloseThread}
        notes={deskNotes}
        docked={docked}
      />
      <ReviewCommentSheet
        enabled
        editor={markers.controller.sheetEditor}
        reviewActions={markers.reviewActions}
        onChangeBody={markers.controller.onChangeEditorBody}
      />
    </View>
  );
}

/** The dock beside the diff, or its sheet: an open thread, else the notes list. */
function SideSlot({
  thread,
  onCloseThread,
  notes,
  docked,
}: {
  thread: ForgeThread | null;
  onCloseThread: () => void;
  notes: ReturnType<typeof useDeskNotes>;
  docked: boolean;
}) {
  if (thread) {
    return docked ? (
      <ThreadPanel thread={thread} onClose={onCloseThread} />
    ) : (
      <ThreadSheet thread={thread} onClose={onCloseThread} />
    );
  }
  if (!notes.open) return null;
  return docked ? (
    <NotesPanel {...notes.list} onClose={notes.closeNotes} />
  ) : (
    <NotesSheet {...notes.list} onClose={notes.closeNotes} />
  );
}

function DeskBody({
  model,
  display,
  documentMode,
  collapseState,
  activePath,
}: {
  model: FilesModel;
  display: React.ComponentProps<typeof DiffDocument>["displayPreferences"];
  documentMode: Extract<React.ComponentProps<typeof DiffDocument>["mode"], { kind: "working" }>;
  collapseState: { paths: readonly string[]; onChange: (paths: string[]) => void };
  activePath: string;
}) {
  const copy = useDeskCopy();
  const { mode, loadedFiles, documentFiles, activeEntry, retryActive } = model;
  if (mode === "single" && !loadedFiles.has(activePath)) {
    if (activeEntry?.state === "failed") {
      return <Notice text={`${copy.patchFailed} ${activeEntry.message}`} onRetry={retryActive} />;
    }
    return <Notice text={copy.loadingPatch} busy />;
  }
  return (
    <DiffDocument
      files={documentFiles}
      displayPreferences={display}
      mode={documentMode}
      collapseState={collapseState}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  desk: { flex: 1, minWidth: 0, minHeight: 0, flexDirection: "row" },
  tree: {
    width: 280,
    borderRightWidth: 1,
    borderRightColor: theme.colors.borderWindow,
    backgroundColor: theme.colors.surfaceChrome,
  },
  treeFull: { flex: 1, backgroundColor: theme.colors.surfaceChrome },
  filterBox: { padding: theme.spacing[2], gap: theme.spacing[2] },
  chips: { flexDirection: "row", gap: theme.spacing[2] },
  main: { flex: 1, minWidth: 0, minHeight: 0 },
  note: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  document: { flex: 1, minHeight: 0, position: "relative" },
}));
