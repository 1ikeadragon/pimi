// Pimi. PolyForm-Noncommercial-1.0.0.
// The Changes tab's file tree. Ordering, nesting, folder rows and folder collapse state come from
// the shared diff tree (`git/diff-tree`, `DiffFolderRow`); the file row is local because it carries
// thread badges and a viewed mark, which the shared `FileHeader` has no slot for.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Text,
  View,
  type FlatList as FlatListType,
  type PressableStateCallbackType,
} from "react-native";
import { Check } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { DiffStat } from "@/components/diff-stat";
import { MaterialFileIcon } from "@/components/material-file-icon";
import {
  treeRowPaddingLeft,
  WORKSPACE_PANE_TRAILING_GLYPH_RAIL,
  WORKSPACE_TREE_ICON_LABEL_GAP,
  WORKSPACE_TREE_ICON_SIZE,
  workspaceTreeRowStyles,
} from "@/components/tree-primitives";
import { PressHighlight } from "@/components/ui/press-highlight";
import { FlatList } from "@/components/ui/scroll-view";
import { DiffFolderRow } from "@/git/diff-folder-row";
import {
  buildDiffTree,
  compressSingleChildChains,
  flattenDiffTree,
  type DiffTreeRow,
} from "@/git/diff-tree";
import { fileNameForPath } from "@/git/file-header-presentation";
import type { ParsedDiffFile } from "@pimi/protocol/messages";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import type { Theme } from "@/styles/theme";
import { useDeskCopy } from "./copy";

const ThemedCheck = withUnistyles(Check);
const viewedIconMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const idleIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });

export interface FileTreeProps {
  files: ParsedDiffFile[];
  activePath: string | null;
  unresolvedByPath: ReadonlyMap<string, number>;
  viewedPaths: ReadonlySet<string>;
  onSelectFile: (path: string) => void;
  onToggleViewed: (path: string) => void;
  /** Scroll this row into view when `seq` changes: a jump that did not start in the tree. */
  reveal: { path: string; seq: number } | null;
}

/** Folder and file rows share one height, so the list can seek without measuring. */
const ROW_HEIGHT = 32;

export function FileTree({
  files,
  activePath,
  unresolvedByPath,
  viewedPaths,
  onSelectFile,
  onToggleViewed,
  reveal,
}: FileTreeProps) {
  const listRef = useRef<FlatListType<DiffTreeRow>>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const tree = useMemo(() => compressSingleChildChains(buildDiffTree(files)), [files]);
  const rows = useMemo(() => flattenDiffTree(tree, collapsed), [collapsed, tree]);

  const revealSeq = reveal?.seq;
  useEffect(() => {
    if (!reveal) return;
    const index = rows.findIndex((row) => row.kind === "file" && row.file.path === reveal.path);
    if (index >= 0) listRef.current?.scrollToIndex({ index, viewPosition: 0.4, animated: false });
    // Only a new reveal request scrolls; row changes from filtering must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealSeq]);

  const getItemLayout = useCallback(
    (_data: ArrayLike<DiffTreeRow> | null | undefined, index: number) => ({
      length: ROW_HEIGHT,
      offset: ROW_HEIGHT * index,
      index,
    }),
    [],
  );

  const toggleFolder = useCallback((dirPath: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(dirPath)) next.add(dirPath);
      return next;
    });
  }, []);
  const collapseFolder = useCallback((dirPath: string) => {
    setCollapsed((current) => new Set(current).add(dirPath));
  }, []);
  const noop = useCallback(() => undefined, []);

  const renderItem = useCallback(
    ({ item }: { item: DiffTreeRow }) => {
      if (item.kind === "folder") {
        return (
          <DiffFolderRow
            dirPath={item.dirPath}
            displayName={item.displayName}
            depth={item.depth}
            collapsed={collapsed.has(item.dirPath)}
            isSelected={selectedFolder === item.dirPath}
            additions={item.additions}
            deletions={item.deletions}
            onToggle={toggleFolder}
            onCollapse={collapseFolder}
            onSelect={setSelectedFolder}
            testID={`review-desk-folder-${item.dirPath}`}
          />
        );
      }
      return (
        <FileRow
          file={item.file}
          depth={item.depth}
          isActive={activePath === item.file.path}
          unresolved={unresolvedByPath.get(item.file.path) ?? 0}
          viewed={viewedPaths.has(item.file.path)}
          onSelect={onSelectFile}
          onToggleViewed={onToggleViewed}
        />
      );
    },
    [
      activePath,
      collapseFolder,
      collapsed,
      onSelectFile,
      onToggleViewed,
      selectedFolder,
      toggleFolder,
      unresolvedByPath,
      viewedPaths,
    ],
  );
  const keyExtractor = useCallback(
    (item: DiffTreeRow) =>
      item.kind === "folder" ? `folder-${item.dirPath}` : `file-${item.file.path}`,
    [],
  );
  void noop;

  return (
    <FlatList
      ref={listRef}
      getItemLayout={getItemLayout}
      data={rows}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      style={styles.list}
      contentContainerStyle={styles.content}
      testID="review-desk-tree"
    />
  );
}

const FileRow = memo(function FileRow({
  file,
  depth,
  isActive,
  unresolved,
  viewed,
  onSelect,
  onToggleViewed,
}: {
  file: ParsedDiffFile;
  depth: number;
  isActive: boolean;
  unresolved: number;
  viewed: boolean;
  onSelect: (path: string) => void;
  onToggleViewed: (path: string) => void;
}) {
  const handlePress = useCallback(() => onSelect(file.path), [file.path, onSelect]);
  const handleViewed = useCallback(() => onToggleViewed(file.path), [file.path, onToggleViewed]);
  const indent = useMemo(
    () => inlineUnistylesStyle({ paddingLeft: treeRowPaddingLeft(depth) }),
    [depth],
  );
  const rowStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      workspaceTreeRowStyles.row,
      styles.row,
      indent,
      (Boolean(hovered) || pressed || isActive) && workspaceTreeRowStyles.active,
    ],
    [indent, isActive],
  );
  const accessibilityState = useMemo(() => ({ selected: isActive }), [isActive]);
  const checkState = useMemo(() => ({ checked: viewed }), [viewed]);
  const copy = useDeskCopy();
  const name = fileNameForPath(file.path);
  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      onPress={handlePress}
      style={rowStyle}
      testID={`review-desk-file-${file.path}`}
    >
      <View style={styles.left}>
        <MaterialFileIcon fileName={name} size={WORKSPACE_TREE_ICON_SIZE} />
        <Text
          style={viewed ? styles.nameViewed : styles.name}
          numberOfLines={1}
          testID={`review-desk-file-name-${file.path}`}
        >
          {name}
        </Text>
      </View>
      <View style={styles.right}>
        {unresolved > 0 ? (
          <View style={styles.badge} testID={`review-desk-badge-${file.path}`}>
            <Text style={styles.badgeText}>{unresolved}</Text>
          </View>
        ) : null}
        <DiffStat additions={file.additions} deletions={file.deletions} />
        <PressHighlight
          accessibilityRole="checkbox"
          accessibilityLabel={viewed ? copy.markUnviewed : copy.markViewed}
          accessibilityState={checkState}
          hitSlop={6}
          onPress={handleViewed}
          style={styles.check}
          testID={`review-desk-viewed-${file.path}`}
        >
          <ThemedCheck size={14} uniProps={viewed ? viewedIconMapping : idleIconMapping} />
        </PressHighlight>
      </View>
    </PressHighlight>
  );
});

const styles = StyleSheet.create((theme) => ({
  list: { flex: 1 },
  content: { paddingBottom: theme.spacing[8] },
  row: { gap: theme.spacing[1], paddingRight: WORKSPACE_PANE_TRAILING_GLYPH_RAIL },
  left: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: WORKSPACE_TREE_ICON_LABEL_GAP,
  },
  name: { flexShrink: 1, fontSize: theme.fontSize.base, color: theme.colors.foreground },
  nameViewed: {
    flexShrink: 1,
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
    opacity: 0.5,
  },
  right: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2], flexShrink: 0 },
  badge: {
    minWidth: 18,
    height: 18,
    paddingHorizontal: 5,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.statusWarning,
  },
  badgeText: { fontSize: theme.fontSize.sm, fontWeight: "600", color: theme.colors.surface0 },
  check: { width: 18, height: 18, alignItems: "center", justifyContent: "center" },
}));
