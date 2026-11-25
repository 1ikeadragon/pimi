import { ChevronsDownUp, ListChecks, Pin } from "lucide-react-native";
import { useCallback, useEffect, useRef, type ReactElement } from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { ActionItem } from "@pimi/protocol/action-items/types";
import { Enter } from "@/action-items/enter";
import { useActionItemsPreferences } from "@/action-items/preferences";
import { useActionItems } from "@/action-items/use-action-items";
import { ActionItemsContent } from "@/action-items/view";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useTranslation } from "@/i18n/use-translation";
import { findPaneById } from "@/stores/workspace-layout-actions";
import {
  selectExplorerSidebarPaneId,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import type { Theme } from "@/styles/theme";
import { openExplorerSidebarView } from "@/workspace-tabs/explorer-sidebar";
import { buildDeterministicWorkspaceTabId } from "@/workspace-tabs/identity";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

const ACTION_ITEMS_TAB_ID = buildDeterministicWorkspaceTabId({ kind: "action_items" });
const ThemedListChecks = withUnistyles(ListChecks);
const ThemedPin = withUnistyles(Pin);
const ThemedCollapse = withUnistyles(ChevronsDownUp);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** True while the Explorer is on screen with Action items in front: the list is docked there. */
function useIsDocked(workspaceKey: string | null): boolean {
  return useWorkspaceLayoutStore((state) => {
    if (!workspaceKey) return false;
    const layout = state.layoutByWorkspace[workspaceKey];
    const paneId = layout ? selectExplorerSidebarPaneId(state, workspaceKey) : null;
    const pane = layout && paneId ? findPaneById(layout.root, paneId) : null;
    if (!pane || pane.hidden === true) return false;
    return pane.focusedTabId === ACTION_ITEMS_TAB_ID;
  });
}

/** The pane width below which the note collapses to its pill: the transcript keeps this much. */
export const ACTION_ITEMS_CARD_MIN_PANE_WIDTH = 880;

export type ActionItemsFloatingState =
  | { display: "none" }
  | {
      display: "pill" | "card";
      serverId: string;
      agentId: string;
      model: ReturnType<typeof useActionItems>;
      items: readonly ActionItem[];
      sawEmpty: boolean;
      pin: () => void;
      collapse: () => void;
      expand: () => void;
    };

/**
 * State of the floating note over a chat's transcript: the same list as the Explorer tab, shown
 * while the list is not docked there. It appears once the chat has an item and collapses to a
 * pill with the open count, also when the pane is `narrow`. Compact layouts use the header menu
 * instead. The chat pane reads `display` to keep the transcript clear of an open card.
 */
export function useActionItemsFloating({
  serverId,
  workspaceId,
  agentId,
  narrow,
  disabled,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  narrow: boolean;
  disabled: boolean;
}): ActionItemsFloatingState {
  const isCompact = useIsCompactFormFactor();
  const paneActive = useRetainedPanelActive();
  const { config } = useDaemonConfig(serverId);
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  const isDocked = useIsDocked(workspaceKey);
  const prefersDocked = useActionItemsPreferences((state) => state.docked);
  const collapsed = useActionItemsPreferences((state) => state.collapsed);
  const enabled = !disabled && !isCompact && config?.metadataGeneration.actionItems !== false;
  const model = useActionItems({ serverId, agentId, active: enabled && paneActive && !isDocked });
  const state = model.state?.agentId === agentId ? model.state : null;
  const hasItems = state !== null && state.items.length > 0;

  // A note over a chat that already has items appears in place. One whose first item arrives
  // while the chat is on screen enters.
  const sawEmpty = useRef(false);
  if (state && !hasItems) sawEmpty.current = true;
  const showsCard = [enabled, !isDocked, hasItems, !collapsed, !narrow].every(Boolean);
  useEffect(() => {
    // Collapsing and expanding afterwards must not replay the entrance.
    if (showsCard) sawEmpty.current = false;
  }, [showsCard]);

  // The pinned preference docks the list once per chat pane; hiding the sidebar afterwards
  // floats it again without fighting the user.
  const appliedDock = useRef(false);
  useEffect(() => {
    if (!enabled || !prefersDocked || !hasItems || isDocked || appliedDock.current) return;
    appliedDock.current = true;
    openExplorerSidebarView({ isCompact: false, workspaceKey, view: "actionItems" });
  }, [enabled, hasItems, isDocked, prefersDocked, workspaceKey]);

  const pin = useCallback(() => {
    useActionItemsPreferences.getState().setDocked(true);
    openExplorerSidebarView({ isCompact: false, workspaceKey, view: "actionItems" });
  }, [workspaceKey]);
  const collapse = useCallback(() => useActionItemsPreferences.getState().setCollapsed(true), []);
  const expand = useCallback(() => useActionItemsPreferences.getState().setCollapsed(false), []);

  if (!state || !hasItems || !enabled || isDocked) return { display: "none" };
  // Pinned and not docked yet: the effect above is about to dock it.
  if (prefersDocked && !appliedDock.current) return { display: "none" };
  return {
    display: collapsed || narrow ? "pill" : "card",
    serverId,
    agentId,
    model,
    items: state.items,
    sawEmpty: sawEmpty.current,
    pin,
    collapse,
    expand,
  };
}

/** The floating note itself: a card over the transcript's top right, or the pill. */
export function ActionItemsFloating({
  floating,
}: {
  floating: ActionItemsFloatingState;
}): ReactElement | null {
  const { t } = useTranslation();
  if (floating.display === "none") return null;
  if (floating.display === "pill") return <Pill items={floating.items} onPress={floating.expand} />;

  return (
    <View style={styles.anchor} pointerEvents="box-none">
      <Enter kind="card" animate={floating.sawEmpty} style={enterStyle}>
        <View style={styles.card} testID="action-items-floating">
          <View style={styles.header}>
            <Text style={styles.title} numberOfLines={1}>
              {t("actionItems.label")}
            </Text>
            <ToolbarButton
              label={t("actionItems.pin")}
              onPress={floating.pin}
              compact
              testID="action-items-pin"
            >
              <ThemedPin size={14} uniProps={mutedMapping} />
            </ToolbarButton>
            <ToolbarButton
              label={t("actionItems.collapse")}
              onPress={floating.collapse}
              compact
              testID="action-items-collapse"
            >
              <ThemedCollapse size={14} uniProps={mutedMapping} />
            </ToolbarButton>
          </View>
          <ActionItemsContent
            serverId={floating.serverId}
            agentId={floating.agentId}
            model={floating.model}
            variant="card"
          />
        </View>
      </Enter>
    </View>
  );
}

function Pill({
  items,
  onPress,
}: {
  items: readonly ActionItem[];
  onPress: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const openCount = items.filter((item) => !item.done).length;
  return (
    <View style={styles.anchor} pointerEvents="box-none">
      <PressHighlight
        style={pillStyle}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={t("actionItems.pillLabel", { count: openCount })}
        testID="action-items-pill"
      >
        <ThemedListChecks size={14} uniProps={mutedMapping} />
        <Text style={styles.pillText}>{openCount}</Text>
      </PressHighlight>
    </View>
  );
}

// Plain objects: the entering node carries no Unistyles style.
const enterStyle = { flexShrink: 1, minHeight: 0, transformOrigin: "top right" } as const;

function pillStyle({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.pill, hovered && styles.pillHovered];
}

/** Width of the open card and the room the transcript leaves for it: card, its inset and a gap. */
export const ACTION_ITEMS_CARD_WIDTH = 288;
const CARD_WIDTH = ACTION_ITEMS_CARD_WIDTH;

const styles = StyleSheet.create((theme) => ({
  // Top-right of the transcript. The right inset clears the scrollbar; the bottom inset keeps
  // a tall note off the transcript's last lines.
  anchor: {
    position: "absolute",
    top: theme.spacing[3],
    right: theme.spacing[6],
    bottom: theme.spacing[8],
    width: CARD_WIDTH,
    alignItems: "flex-end",
  },
  card: {
    width: CARD_WIDTH,
    flexShrink: 1,
    minHeight: 0,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
    ...theme.shadow.md,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[2],
    paddingTop: theme.spacing[2],
  },
  title: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    ...theme.shadow.sm,
  },
  pillHovered: { backgroundColor: theme.colors.surface2 },
  pillText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
}));
