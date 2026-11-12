// Pimi. Apache-2.0.
// The bar above the diff: current file, viewed counter, single-file stepping, mode and layout.
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { DiffLayoutToggle } from "@/git/diff-pane";
import { DESK_COPY } from "./copy";
import type { DeskMode } from "./use-patches";

export interface DeskToolbarProps {
  activePath: string;
  viewedLabel: string;
  mode: DeskMode;
  canToggleMode: boolean;
  showFilesButton: boolean;
  canSplit: boolean;
  layout: "unified" | "split";
  onShowFiles: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onToggleMode: () => void;
  onToggleLayout: () => void;
}

export function DeskToolbar(props: DeskToolbarProps) {
  return (
    <View style={styles.toolbar} testID="review-desk-toolbar">
      {props.showFilesButton ? (
        <Button size="sm" variant="outline" onPress={props.onShowFiles}>
          Files
        </Button>
      ) : null}
      <Text style={styles.path} numberOfLines={1} testID="review-desk-active-path">
        {props.activePath}
      </Text>
      <Text style={styles.meta} testID="review-desk-viewed-count">
        {props.viewedLabel}
      </Text>
      {props.mode === "single" ? (
        <>
          <Button
            size="sm"
            variant="outline"
            accessibilityLabel={DESK_COPY.previous}
            onPress={props.onPrevious}
            testID="review-desk-previous"
          >
            {"<"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            accessibilityLabel={DESK_COPY.next}
            onPress={props.onNext}
            testID="review-desk-next"
          >
            {">"}
          </Button>
        </>
      ) : null}
      {props.canToggleMode ? (
        <Button size="sm" variant="outline" onPress={props.onToggleMode}>
          {props.mode === "single" ? DESK_COPY.showAll : DESK_COPY.showSingle}
        </Button>
      ) : null}
      {props.canSplit ? (
        <DiffLayoutToggle layout={props.layout} isMobile={false} onToggle={props.onToggleLayout} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  path: { flex: 1, minWidth: 0, fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  meta: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
}));
