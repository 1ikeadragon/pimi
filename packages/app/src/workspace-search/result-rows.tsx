import { memo, useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "@/i18n/use-translation";
import type { WorkspaceSearchMatch } from "@pimi/protocol/workspace-search";
import { MaterialFileIcon } from "@/components/material-file-icon";
import {
  TreeChevron,
  treeRowPaddingLeft,
  workspaceTreeRowStyles,
  WORKSPACE_TREE_ICON_LABEL_GAP,
  WORKSPACE_TREE_ICON_SIZE,
} from "@/components/tree-primitives";
import { HighlightedText } from "@/components/ui/highlighted-text";
import { mutedIconColorMapping } from "@/components/ui/icon-button-chrome";
import { PressHighlight } from "@/components/ui/press-highlight";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { buildReplacePreview, type WorkspaceSearchForm } from "./query";
import type { SearchResultFile } from "./store";

/** Every row is one line tall, so the list can compute offsets instead of measuring. */
export const SEARCH_ROW_HEIGHT = 26;
const DISMISS_ICON_SIZE = 14;

const DismissIcon = withUnistyles(X, mutedIconColorMapping);

export type SearchRow =
  | { type: "file"; key: string; file: SearchResultFile }
  | { type: "match"; key: string; file: SearchResultFile; match: WorkspaceSearchMatch };

function splitPath(path: string): { name: string; directory: string } {
  const slash = path.lastIndexOf("/");
  return slash === -1
    ? { name: path, directory: "" }
    : { name: path.slice(slash + 1), directory: path.slice(0, slash) };
}

/** Hover-reveals its dismiss button on desktop; touch has no hover, so it stays visible there. */
function useRowHover() {
  const [hovered, setHovered] = useState(false);
  const isCompact = useIsCompactFormFactor();
  const enter = useCallback(() => setHovered(true), []);
  const leave = useCallback(() => setHovered(false), []);
  return { hovered, showActions: hovered || isNative || isCompact, enter, leave, isCompact };
}

export const FileResultRow = memo(function FileResultRow({
  file,
  onToggle,
  onDismiss,
}: {
  file: SearchResultFile;
  onToggle(path: string): void;
  onDismiss(path: string): void;
}) {
  const { t } = useTranslation();
  const hover = useRowHover();
  const { name, directory } = splitPath(file.path);
  const expandedState = useMemo(() => ({ expanded: !file.collapsed }), [file.collapsed]);
  const toggle = useCallback(() => onToggle(file.path), [file.path, onToggle]);
  const dismiss = useCallback(() => onDismiss(file.path), [file.path, onDismiss]);
  return (
    <View style={styles.rowFrame} onPointerEnter={hover.enter} onPointerLeave={hover.leave}>
      <PressHighlight
        style={[styles.row, { paddingLeft: treeRowPaddingLeft(0) }]}
        onPress={toggle}
        accessibilityRole="button"
        accessibilityState={expandedState}
        accessibilityLabel={file.path}
      >
        <TreeChevron expanded={!file.collapsed} />
        <MaterialFileIcon fileName={name} size={WORKSPACE_TREE_ICON_SIZE} />
        <Text style={[styles.fileName, workspaceTreeRowStyles.name]} numberOfLines={1}>
          {name}
        </Text>
        {directory ? (
          <Text style={styles.directory} numberOfLines={1}>
            {directory}
          </Text>
        ) : null}
        <View style={styles.spacer} />
        {hover.showActions ? null : <Text style={styles.count}>{file.occurrences}</Text>}
      </PressHighlight>
      {hover.showActions ? (
        <View style={styles.actions}>
          <Text style={styles.count}>{file.occurrences}</Text>
          <ToolbarButton
            label={t("workspaceSearch.dismissFile")}
            compact={hover.isCompact}
            onPress={dismiss}
          >
            <DismissIcon size={DISMISS_ICON_SIZE} />
          </ToolbarButton>
        </View>
      ) : null}
    </View>
  );
});

export const MatchResultRow = memo(function MatchResultRow({
  file,
  match,
  form,
  replacing,
  dismissed,
  onOpen,
  onDismiss,
}: {
  file: SearchResultFile;
  match: WorkspaceSearchMatch;
  form: WorkspaceSearchForm;
  /** The replace field is open, so the line previews its result. */
  replacing: boolean;
  dismissed: boolean;
  onOpen(file: SearchResultFile, match: WorkspaceSearchMatch): void;
  onDismiss(path: string, line: number): void;
}) {
  const { t } = useTranslation();
  const hover = useRowHover();
  const open = useCallback(() => onOpen(file, match), [file, match, onOpen]);
  const dismiss = useCallback(
    () => onDismiss(file.path, match.line),
    [file.path, match.line, onDismiss],
  );
  // A match the daemon could not locate has no range, so the whole line is marked.
  const ranges =
    match.ranges.length > 0
      ? match.ranges.map(([start, end]) => ({ start, length: end - start }))
      : [{ start: 0, length: match.preview.length }];
  return (
    <View style={styles.rowFrame} onPointerEnter={hover.enter} onPointerLeave={hover.leave}>
      <PressHighlight
        style={[styles.row, { paddingLeft: treeRowPaddingLeft(1) + WORKSPACE_TREE_ICON_SIZE }]}
        onPress={open}
        accessibilityRole="button"
        accessibilityLabel={`${file.path}:${match.line}`}
      >
        <Text style={styles.lineNumber}>{match.line}</Text>
        <View style={[styles.preview, dismissed && styles.dismissed]}>
          {match.previewOffset > 0 ? <Text style={styles.ellipsis}>…</Text> : null}
          {replacing && match.ranges.length > 0 && !dismissed ? (
            <ReplacePreviewText match={match} form={form} />
          ) : (
            <HighlightedText
              text={match.preview}
              ranges={ranges}
              style={styles.code}
              numberOfLines={1}
            />
          )}
        </View>
      </PressHighlight>
      {hover.showActions && !dismissed ? (
        <View style={styles.actions}>
          <ToolbarButton
            label={t("workspaceSearch.dismissMatch")}
            compact={hover.isCompact}
            onPress={dismiss}
          >
            <DismissIcon size={DISMISS_ICON_SIZE} />
          </ToolbarButton>
        </View>
      ) : null}
    </View>
  );
});

function ReplacePreviewText({
  match,
  form,
}: {
  match: WorkspaceSearchMatch;
  form: WorkspaceSearchForm;
}) {
  const segments = buildReplacePreview(match, form);
  return (
    <Text style={styles.code} numberOfLines={1}>
      {segments.map((segment, index) => (
        <Text
          // Segments are positional: the same preview always yields the same list.
          // oxlint-disable-next-line react/no-array-index-key
          key={index}
          style={PREVIEW_SEGMENT_STYLES[segment.kind]}
        >
          {segment.text}
        </Text>
      ))}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  rowFrame: {
    height: SEARCH_ROW_HEIGHT,
    position: "relative",
  },
  row: {
    height: SEARCH_ROW_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: WORKSPACE_TREE_ICON_LABEL_GAP,
    paddingRight: theme.spacing[3],
  },
  spacer: { flex: 1 },
  fileName: {
    fontSize: theme.fontSize.base,
    flexShrink: 0,
    maxWidth: "70%",
  },
  directory: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
  },
  count: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    paddingHorizontal: theme.spacing[1],
  },
  actions: {
    position: "absolute",
    right: theme.spacing[1],
    top: 0,
    bottom: 0,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.colors.surface0,
  },
  lineNumber: {
    minWidth: 28,
    textAlign: "right",
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
  },
  preview: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
  },
  dismissed: { opacity: 0.4 },
  ellipsis: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
  },
  code: {
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
  },
  removed: {
    textDecorationLine: "line-through",
    color: theme.colors.foregroundMuted,
  },
  added: {
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface3,
  },
}));

const PREVIEW_SEGMENT_STYLES = {
  text: undefined,
  removed: styles.removed,
  added: styles.added,
} as const;
