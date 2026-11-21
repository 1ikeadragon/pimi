// Pimi. PolyForm-Noncommercial-1.0.0.
// The thin bar above the diff: the active path, how many files are viewed, one file or all, and
// unified / split. Compact screens add the Files button that opens the tree as a page. Moving
// between files is the tree and j / k.
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { DiffLayoutToggle } from "@/git/diff-pane";
import { useDeskCopy } from "./copy";
import type { DeskMode } from "./use-patches";

export interface FilesBarProps {
  activePath: string;
  viewedLabel: string;
  mode: DeskMode;
  canToggleMode: boolean;
  showFilesButton: boolean;
  canSplit: boolean;
  layout: "unified" | "split";
  onShowFiles: () => void;
  onToggleMode: () => void;
  onToggleLayout: () => void;
}

export function FilesBar(props: FilesBarProps) {
  const copy = useDeskCopy();
  return (
    <View style={styles.bar} testID="review-files-bar">
      {props.showFilesButton ? (
        <Button size="sm" variant="outline" onPress={props.onShowFiles}>
          {copy.files}
        </Button>
      ) : null}
      <Text
        style={styles.path}
        numberOfLines={1}
        ellipsizeMode="head"
        testID="review-desk-active-path"
      >
        {props.activePath}
      </Text>
      <Text style={styles.meta} testID="review-desk-viewed-count">
        {props.viewedLabel}
      </Text>
      {props.canToggleMode ? (
        <Button size="sm" variant="ghost" onPress={props.onToggleMode}>
          {props.mode === "single" ? copy.showAll : copy.showSingle}
        </Button>
      ) : null}
      {props.canSplit ? (
        <DiffLayoutToggle layout={props.layout} isMobile={false} onToggle={props.onToggleLayout} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  path: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
  },
  meta: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
  },
}));
