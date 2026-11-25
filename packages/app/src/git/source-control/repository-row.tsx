import { memo, useCallback, useState } from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ExternalLink, FolderOpen, MoreVertical, RotateCw } from "lucide-react-native";
import type { NestedChangesRepository } from "@pimi/protocol/messages";
import { useOpenKebabMenuVisibility } from "@/components/sidebar/use-open-kebab-menu-visibility";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PressHighlight } from "@/components/ui/press-highlight";
import {
  TreeChevron,
  treeRowPaddingLeft,
  workspaceTreeRowStyles,
  WORKSPACE_TREE_ICON_LABEL_GAP,
} from "@/components/tree-primitives";
import { isNative } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useTranslation } from "@/i18n/use-translation";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import type { Theme } from "@/styles/theme";

const ThemedMoreVertical = withUnistyles(MoreVertical);
const ThemedRotateCw = withUnistyles(RotateCw);
const ThemedExternalLink = withUnistyles(ExternalLink);
const ThemedFolderOpen = withUnistyles(FolderOpen);

const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });

const EXPANDED_STATE = { expanded: true } as const;
const COLLAPSED_STATE = { expanded: false } as const;

const KEBAB_ICON_SIZE = 14;
/** The kebab box; the count shares its width so swapping one for the other moves nothing. */
const KEBAB_SIZE = 24;

interface RepositoryRowProps {
  repository: NestedChangesRepository;
  expanded: boolean;
  onToggle: (root: string) => void;
  onRefresh: (root: string) => void;
  onOpenInReview: ((root: string) => void) | null;
  onReveal: ((root: string) => void) | null;
  revealTargetName: string | undefined;
}

function repositoryPressableStyle({
  hovered,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [
    workspaceTreeRowStyles.row,
    (Boolean(hovered) || pressed) && workspaceTreeRowStyles.active,
  ];
}

function kebabStyle({ hovered }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.kebab, Boolean(hovered) && styles.kebabHovered];
}

function renderKebabIcon({ hovered }: { hovered?: boolean }) {
  return (
    <ThemedMoreVertical
      size={KEBAB_ICON_SIZE}
      uniProps={hovered ? foregroundMapping : mutedMapping}
    />
  );
}

const refreshIcon = <ThemedRotateCw size={KEBAB_ICON_SIZE} uniProps={mutedMapping} />;
const reviewIcon = <ThemedExternalLink size={KEBAB_ICON_SIZE} uniProps={mutedMapping} />;
const revealIcon = <ThemedFolderOpen size={KEBAB_ICON_SIZE} uniProps={mutedMapping} />;

/**
 * One repository's group header. Hover is tracked on the plain outer View and press on the inner
 * pressable (docs/hover.md); the kebab shares the count's slot so revealing it moves nothing.
 */
export const RepositoryRow = memo(function RepositoryRow({
  repository,
  expanded,
  onToggle,
  onRefresh,
  onOpenInReview,
  onReveal,
  revealTargetName,
}: RepositoryRowProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const kebab = useOpenKebabMenuVisibility(isHovered || isNative || isCompact);
  const { root } = repository;
  const handlePress = useCallback(() => onToggle(root), [onToggle, root]);
  const handleRefresh = useCallback(() => onRefresh(root), [onRefresh, root]);
  const handleOpenInReview = useCallback(() => onOpenInReview?.(root), [onOpenInReview, root]);
  const handleReveal = useCallback(() => onReveal?.(root), [onReveal, root]);

  const branchLabel = repository.branch ?? t("panels.sourceControl.detached");
  const sync = `${repository.ahead > 0 ? ` ↑${repository.ahead}` : ""}${repository.behind > 0 ? ` ↓${repository.behind}` : ""}`;
  const count = `${repository.files.length}${repository.truncated ? "+" : ""}`;

  return (
    <View
      style={styles.hoverTarget}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      testID={`source-control-group-${repository.name}`}
    >
      <PressHighlight
        onPress={handlePress}
        style={repositoryPressableStyle}
        accessibilityRole="button"
        accessibilityState={expanded ? EXPANDED_STATE : COLLAPSED_STATE}
      >
        <View style={[styles.left, inlineUnistylesStyle({ paddingLeft: treeRowPaddingLeft(0) })]}>
          <TreeChevron expanded={expanded} />
          <Text style={styles.name} numberOfLines={1} ellipsizeMode="middle">
            {repository.name}
          </Text>
          <Text style={styles.branch} numberOfLines={1} ellipsizeMode="middle">
            {`${branchLabel}${sync}`}
          </Text>
        </View>
        <Text style={[styles.count, kebab.showKebab && styles.countHidden]}>
          {repository.error === null ? count : "!"}
        </Text>
      </PressHighlight>
      <View
        style={[styles.kebabSlot, !kebab.showKebab && styles.kebabSlotHidden]}
        pointerEvents={kebab.showKebab ? "auto" : "none"}
      >
        <DropdownMenu compactMode="sheet" {...kebab.menuProps}>
          <DropdownMenuTrigger
            hitSlop={8}
            style={kebabStyle}
            accessibilityLabel={t("panels.sourceControl.repositoryActions")}
            testID={`source-control-kebab-${repository.name}`}
          >
            {renderKebabIcon}
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            width={220}
            sheetTitle={t("panels.sourceControl.repositoryActions")}
          >
            {onOpenInReview ? (
              <DropdownMenuItem leading={reviewIcon} onSelect={handleOpenInReview}>
                {t("panels.sourceControl.openInReview")}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem leading={refreshIcon} onSelect={handleRefresh}>
              {t("panels.sourceControl.refresh")}
            </DropdownMenuItem>
            {onReveal ? (
              <DropdownMenuItem leading={revealIcon} onSelect={handleReveal}>
                {t("workspace.fileActions.revealIn", { target: revealTargetName })}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme: Theme) => ({
  hoverTarget: {
    position: "relative",
  },
  left: {
    flexDirection: "row",
    alignItems: "center",
    gap: WORKSPACE_TREE_ICON_LABEL_GAP,
    flex: 1,
    minWidth: 0,
  },
  name: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
    flexShrink: 0,
    maxWidth: "60%",
    userSelect: "none",
  },
  branch: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
    minWidth: 0,
    userSelect: "none",
  },
  count: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    paddingLeft: theme.spacing[2],
    minWidth: KEBAB_SIZE,
    textAlign: "right",
  },
  countHidden: {
    opacity: 0,
  },
  kebabSlot: {
    position: "absolute",
    right: theme.spacing[2],
    top: 0,
    bottom: 0,
    justifyContent: "center",
  },
  kebabSlotHidden: {
    opacity: 0,
  },
  kebab: {
    width: KEBAB_SIZE,
    height: KEBAB_SIZE,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  kebabHovered: {
    backgroundColor: theme.colors.surface2,
  },
}));
