import type { ReactElement } from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { RotateCw } from "lucide-react-native";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { PressHighlight } from "@/components/ui/press-highlight";
import { FlatList } from "@/components/ui/scroll-view";
import {
  TreeChevron,
  treeRowPaddingLeft,
  workspaceTreeRowStyles,
  WORKSPACE_TREE_ICON_LABEL_GAP,
} from "@/components/tree-primitives";
import type { SourceControlModel, SourceControlRow } from "@/git/source-control/rows";
import type { NestedChangesState } from "@/git/use-nested-changes";
import { useTranslation } from "@/i18n/use-translation";
import { isWeb } from "@/constants/platform";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import type { Theme } from "@/styles/theme";

const ThemedRotateCw = withUnistyles(RotateCw);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const EXPANDED_STATE = { expanded: true } as const;
const COLLAPSED_STATE = { expanded: false } as const;

const REFRESH_ICON_SIZE = 14;
/** The refresh button box, the same 24px control box the repository kebab uses. */
const REFRESH_BUTTON_SIZE = 24;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;

function rowPressableStyle({
  hovered,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [
    workspaceTreeRowStyles.row,
    (Boolean(hovered) || pressed) && workspaceTreeRowStyles.active,
  ];
}

export { rowPressableStyle };

interface PanelBodyProps {
  state: NestedChangesState;
  model: SourceControlModel;
  renderItem: (info: { item: SourceControlRow }) => ReactElement;
  keyExtractor: (item: SourceControlRow) => string;
}

export function PanelBody({ state, model, renderItem, keyExtractor }: PanelBodyProps) {
  const { t } = useTranslation();
  if (state.status === "idle" || (state.status === "loading" && model.repositoryCount === 0)) {
    return (
      <View style={styles.centerState}>
        <ThemedLoadingSpinner uniProps={mutedColorMapping} />
        <Text style={styles.mutedText}>{t("panels.sourceControl.loading")}</Text>
      </View>
    );
  }
  if (state.status === "error" && model.repositoryCount === 0) {
    return (
      <View style={styles.centerState}>
        <Text style={styles.errorText} selectable testID="source-control-error">
          {t("panels.sourceControl.loadError", { error: state.error })}
        </Text>
      </View>
    );
  }
  if (model.repositoryCount === 0) {
    return (
      <View style={styles.centerState}>
        <Text style={styles.mutedText} testID="source-control-empty">
          {t("panels.sourceControl.empty")}
        </Text>
      </View>
    );
  }
  return (
    <FlatList
      data={model.rows}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      style={styles.list}
      contentContainerStyle={styles.listContent}
      testID="source-control-list"
    />
  );
}

interface CleanRowProps {
  count: number;
  expanded: boolean;
  onToggle: () => void;
}

export function CleanRow({ count, expanded, onToggle }: CleanRowProps) {
  const { t } = useTranslation();
  return (
    <PressHighlight
      onPress={onToggle}
      style={rowPressableStyle}
      accessibilityRole="button"
      accessibilityState={expanded ? EXPANDED_STATE : COLLAPSED_STATE}
      testID="source-control-clean"
    >
      <View
        style={[styles.cleanLeft, inlineUnistylesStyle({ paddingLeft: treeRowPaddingLeft(0) })]}
      >
        <TreeChevron expanded={expanded} />
        <Text style={styles.cleanLabel} numberOfLines={1}>
          {t("panels.sourceControl.cleanRepositories", { count })}
        </Text>
      </View>
    </PressHighlight>
  );
}

interface HeaderProps {
  repositoryCount: number;
  changeCount: number;
  checking: boolean;
  oldestCheckedAt: number | null;
  now: number;
  refreshing: boolean;
  onRefresh: () => void;
}

export function SourceControlHeader({
  repositoryCount,
  changeCount,
  checking,
  oldestCheckedAt,
  now,
  refreshing,
  onRefresh,
}: HeaderProps) {
  const { t } = useTranslation();
  const parts = [
    t("panels.sourceControl.repositoryCount", { count: repositoryCount }),
    t("panels.sourceControl.changeCount", { count: changeCount }),
  ];
  if (checking) {
    parts.push(t("panels.sourceControl.checking"));
  } else if (oldestCheckedAt !== null) {
    const seconds = Math.max(0, Math.floor((now - oldestCheckedAt) / MS_PER_SECOND));
    parts.push(
      seconds < SECONDS_PER_MINUTE
        ? t("panels.sourceControl.checkedSecondsAgo", { count: seconds })
        : t("panels.sourceControl.checkedMinutesAgo", {
            count: Math.floor(seconds / SECONDS_PER_MINUTE),
          }),
    );
  }
  return (
    <View style={styles.header}>
      <PressHighlight
        onPress={onRefresh}
        disabled={refreshing}
        accessibilityRole="button"
        accessibilityLabel={
          refreshing ? t("panels.sourceControl.refreshing") : t("panels.sourceControl.refresh")
        }
        style={styles.refreshButton}
        testID="source-control-refresh"
      >
        {refreshing ? (
          <ThemedLoadingSpinner size="small" uniProps={mutedColorMapping} />
        ) : (
          <ThemedRotateCw size={REFRESH_ICON_SIZE} uniProps={mutedColorMapping} />
        )}
      </PressHighlight>
      <Text style={styles.headerText} numberOfLines={1} testID="source-control-summary">
        {parts.join(" · ")}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  headerText: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  refreshButton: {
    width: REFRESH_BUTTON_SIZE,
    height: REFRESH_BUTTON_SIZE,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingBottom: theme.spacing[8],
  },
  cleanLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: WORKSPACE_TREE_ICON_LABEL_GAP,
    flex: 1,
    minWidth: 0,
  },
  cleanLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
    userSelect: "none",
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[6],
  },
  mutedText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  errorText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.destructive,
    textAlign: "center",
    // A long path in the message has no break point of its own.
    ...(isWeb ? { overflowWrap: "anywhere" } : null),
  },
}));
