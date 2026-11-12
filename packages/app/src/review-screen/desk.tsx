// Pimi. Apache-2.0.
// Stream S3: the Changes tab. A file tree beside the shared `DiffDocument`, fed by
// `forge.change_request.list_files` (tree first, no patches) and `get_file_diffs` (patches on
// demand through the LRU cache in `desk/patch-cache.ts`). Small change requests scroll as one
// document; large ones show a file at a time. Forge threads draw under their lines and the user's
// own line annotations leave through "Ask in chat" (`desk/ask-in-chat.tsx`).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SearchField } from "@/components/ui/search-field";
import { DiffDocument } from "@/git/diff-document";
import { DiffDocumentWorkspaceCacheProvider } from "@/git/diff-document/workspace-cache";
import { orderCheckoutDiffFiles } from "@/git/diff-order";
import { ReviewCommentSheet } from "@/review";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { Text } from "react-native";
import type { ChangeRequestSource, ReviewDeskProps } from "./types";
import { AskInChat } from "./desk/ask-in-chat";
import { DESK_COPY } from "./desk/copy";
import { FileTree } from "./desk/file-tree";
import { DeskToolbar } from "./desk/toolbar";
import { Chip, DetachedThreads, Notice } from "./desk/ui";
import {
  chooseDiffMode,
  stubFile,
  useDeskFiles,
  useDeskThreads,
  type DeskFileList,
} from "./desk/use-desk-data";
import {
  useDeskDisplay,
  useDeskFilter,
  useDeskKeyboard,
  useDeskViewed,
} from "./desk/use-desk-state";
import { useDeskPatches } from "./desk/use-patches";
import { useReviewMarkers } from "./desk/use-review-markers";

export function ReviewDesk({ source, focus }: ReviewDeskProps) {
  if (source.kind !== "change_request") {
    return <Notice text={DESK_COPY.checkoutUnsupported} />;
  }
  return (
    <DiffDocumentWorkspaceCacheProvider>
      <ChangeRequestDesk source={source} focus={focus} />
    </DiffDocumentWorkspaceCacheProvider>
  );
}

function ChangeRequestDesk({
  source,
  focus,
}: {
  source: ChangeRequestSource;
  focus: ReviewDeskProps["focus"];
}) {
  const filesState = useDeskFiles(source);
  if (filesState.status === "loading") return <Notice text={DESK_COPY.loadingFiles} busy />;
  if (filesState.status === "error") {
    return (
      <Notice text={`${DESK_COPY.loadError} ${filesState.message}`} onRetry={filesState.retry} />
    );
  }
  if (filesState.list.files.length === 0) return <Notice text={DESK_COPY.noFiles} />;
  return <ReadyDesk source={source} list={filesState.list} focus={focus} />;
}

interface FocusTarget {
  path: string;
  line: number | null;
  seq: number;
}

/** Which path the document scrolls to, and when; see `useDocumentMode`. */
function useFocusTarget(paths: readonly string[], focus: ReviewDeskProps["focus"]) {
  const [activePath, setActivePath] = useState<string>(() => focus?.path ?? paths[0] ?? "");
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
  const nonce = focus?.nonce;
  useEffect(() => {
    if (focus && paths.includes(focus.path)) jumpTo(focus.path, focus.line);
    // Keyed on the request's nonce: repeating the same target must still fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);
  return { activePath, target, reveal, moveTo, selectInTree };
}

function ReadyDesk({
  source,
  list,
  focus,
}: {
  source: ChangeRequestSource;
  list: DeskFileList;
  focus: ReviewDeskProps["focus"];
}) {
  const client = useHostRuntimeClient(source.serverId);
  const display = useDeskDisplay();
  const { isCompact } = display;

  // Tree order is the single order for tree, document and next/previous.
  const stubs = useMemo(() => orderCheckoutDiffFiles(list.files.map(stubFile)), [list.files]);
  const paths = useMemo(() => stubs.map((file) => file.path), [stubs]);
  const blobByPath = useMemo(
    () => new Map(list.files.map((file) => [file.path, file.blobSha])),
    [list.files],
  );
  const eligibleMode = chooseDiffMode(list);
  const [singleOverride, setSingleOverride] = useState(false);
  const mode = eligibleMode === "single" || singleOverride ? "single" : "continuous";
  const toggleMode = useCallback(() => setSingleOverride((current) => !current), []);

  const { activePath, target, reveal, moveTo, selectInTree } = useFocusTarget(paths, focus);
  const patches = useDeskPatches({
    client,
    source,
    headSha: list.headSha,
    stubs,
    mode,
    activePath,
  });
  const { loadedFiles } = patches;

  const threads = useDeskThreads(source);
  const markers = useReviewMarkers({ source, threads: threads.threads, loadedFiles });
  const unresolvedByPath = useMemo(() => {
    const out = new Map<string, number>();
    for (const [path, count] of threads.counts) out.set(path, count.unresolved);
    return out;
  }, [threads.counts]);

  const { viewedPaths, toggleViewed } = useDeskViewed(source, paths, blobByPath);
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
  const activeIndex = paths.indexOf(activePath);
  const goPrevious = useCallback(() => {
    const previous = paths[activeIndex - 1];
    if (previous) moveTo(previous);
  }, [activeIndex, moveTo, paths]);
  const goNext = useCallback(() => {
    const next = paths[activeIndex + 1];
    if (next) moveTo(next);
  }, [activeIndex, moveTo, paths]);
  const openDetached = useCallback(
    (path: string, id: string) => {
      markers.showThread(id);
      moveTo(path);
    },
    [markers, moveTo],
  );

  const treePane = (
    <View style={isCompact ? styles.treeFull : styles.tree} testID="review-desk-tree-pane">
      <View style={styles.filterBox}>
        <SearchField
          value={filter.filter}
          onChangeText={filter.setFilter}
          placeholder={DESK_COPY.filterPlaceholder}
          clearAccessibilityLabel={DESK_COPY.filterClear}
          testID="review-desk-filter"
        />
        <View style={styles.chips}>
          <Chip
            label={DESK_COPY.unviewedOnly}
            active={filter.unviewedOnly}
            onToggle={filter.toggleUnviewed}
          />
          <Chip
            label={DESK_COPY.withThreads}
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
    <View style={styles.desk} testID="review-desk">
      {isCompact ? null : treePane}
      <View style={styles.main}>
        <DeskToolbar
          activePath={activePath}
          viewedLabel={DESK_COPY.viewed(viewedPaths.size, paths.length)}
          mode={mode}
          canToggleMode={eligibleMode === "continuous"}
          showFilesButton={isCompact}
          canSplit={display.canSplit}
          layout={display.layout}
          onShowFiles={showTree}
          onPrevious={goPrevious}
          onNext={goNext}
          onToggleMode={toggleMode}
          onToggleLayout={display.toggleLayout}
        />
        {eligibleMode === "single" ? (
          <Text style={styles.note}>{DESK_COPY.singleFileNote(list.totalFiles)}</Text>
        ) : null}
        {threads.error ? <Text style={styles.note}>{DESK_COPY.threadsFailed}</Text> : null}
        <DetachedThreads detached={markers.detached} onOpen={openDetached} />
        <View style={styles.document} testID="review-desk-document">
          <DeskBody
            mode={mode}
            patches={patches}
            display={display.displayPreferences}
            documentMode={documentMode}
            collapseState={collapseState}
            activePath={activePath}
          />
        </View>
        <AskInChat
          source={source}
          reviewDraftKey={markers.reviewDraftKey}
          draftCount={markers.draftCount}
          loadedFiles={loadedFiles}
          baseRef={null}
        />
      </View>
      <ReviewCommentSheet
        enabled
        editor={markers.controller.sheetEditor}
        reviewActions={markers.reviewActions}
        onChangeBody={markers.controller.onChangeEditorBody}
      />
    </View>
  );
}

function DeskBody({
  mode,
  patches,
  display,
  documentMode,
  collapseState,
  activePath,
}: {
  mode: "continuous" | "single";
  patches: ReturnType<typeof useDeskPatches>;
  display: React.ComponentProps<typeof DiffDocument>["displayPreferences"];
  documentMode: Extract<React.ComponentProps<typeof DiffDocument>["mode"], { kind: "working" }>;
  collapseState: { paths: readonly string[]; onChange: (paths: string[]) => void };
  activePath: string;
}) {
  const { loadedFiles, documentFiles, activeEntry, retryActive } = patches;
  if (mode === "single" && !loadedFiles.has(activePath)) {
    if (activeEntry?.state === "failed") {
      return (
        <Notice text={`${DESK_COPY.patchFailed} ${activeEntry.message}`} onRetry={retryActive} />
      );
    }
    return <Notice text={DESK_COPY.loadingPatch} busy />;
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
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  treeFull: { flex: 1, backgroundColor: theme.colors.surfaceSidebar },
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
