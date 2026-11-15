import { memo, useCallback, useMemo, type ReactElement } from "react";
import { useTranslation } from "@/i18n/use-translation";
import {
  Text,
  View,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ThemedChevron, chevronColorMapping } from "@/git/themed-chevron";
import equal from "fast-deep-equal";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { ModelProviderGlyph } from "@/components/model-browser";
import { LabelDots } from "@/labels/target-chips";
import type { LabelTarget } from "@pimi/protocol/labels";
import { PressHighlight } from "@/components/ui/press-highlight";
import { isWeb } from "@/constants/platform";
import { getDesktopHost } from "@/desktop/host";
import { usePendingArchiveAgentKeys } from "@/hooks/use-archive-agent";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { usePanelStore } from "@/stores/panel-store";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { useSessionStore } from "@/stores/session-store";
import { density, densityIconBox } from "@/styles/density";
import { useProviderSubagentStore } from "@/subagents/provider-store";
import {
  selectSidebarLineage,
  sidebarLineageWorkspaceKey,
  type SidebarLineage,
  type SidebarLineageWorker,
} from "@/subagents/sidebar-lineage";
import { SUBAGENT_STATUS_LABEL_KEYS } from "@/subagents/status";
import { SubagentStatusDot } from "@/subagents/status-dot";
import { resolveRowLabel } from "@/subagents/track-presentation";
import { navigateToAgent } from "@/utils/navigate-to-agent";

const PROVIDER_GLYPH_SIZE = 14;

// Mirrors the workspace row's press: navigation only closes the compact sidebar when it reveals a
// different workspace, so a row in the workspace already shown closes it itself.
function openAgent(agent: { serverId: string; agentId: string }) {
  getDesktopHost()?.dismissPimiWorkspace?.();
  usePanelStore.getState().showMobileAgent();
  navigateToAgent({ serverId: agent.serverId, agentId: agent.agentId });
}

function openWorker(worker: SidebarLineageWorker) {
  if (worker.kind === "agent") {
    openAgent(worker);
    return;
  }
  getDesktopHost()?.dismissPimiWorkspace?.();
  usePanelStore.getState().showMobileAgent();
  navigateToWorkspace({
    serverId: worker.serverId,
    workspaceId: worker.workspaceId,
    target: {
      kind: "provider_subagent",
      parentAgentId: worker.parentAgentId,
      subagentId: worker.subagentId,
    },
  });
}

function workerKey(worker: SidebarLineageWorker): string {
  return worker.kind === "agent"
    ? `${worker.serverId}:${worker.agentId}`
    : `${worker.serverId}:${worker.parentAgentId}:${worker.subagentId}`;
}

const COLLAPSED_STATE = { expanded: false };
const EXPANDED_STATE = { expanded: true };

/**
 * What hangs under a chat row: the chat's subagents, behind its Lineage line. Renders nothing for
 * a chat without subagents, so the cost there is one shared-index lookup per session-store update.
 */
export const SidebarAgentLineage = memo(function SidebarAgentLineage({
  serverId,
  workspaceId,
  indentStyle,
}: {
  serverId: string | null | undefined;
  workspaceId: string;
  /** The workspace row's own indent, so nested rows keep its title rail in every grouping. */
  indentStyle?: StyleProp<ViewStyle>;
}): ReactElement | null {
  const workspaceKey = serverId ? sidebarLineageWorkspaceKey(serverId, workspaceId) : null;
  const descriptors = useProviderSubagentStore((state) => state.descriptors);
  const hiddenFromTrack = useProviderSubagentStore((state) => state.hiddenFromTrack);
  const selectLineage = useCallback(
    (state: ReturnType<typeof useSessionStore.getState>) =>
      workspaceKey
        ? selectSidebarLineage(state.sessions, { descriptors, hiddenFromTrack }, workspaceKey)
        : null,
    [workspaceKey, descriptors, hiddenFromTrack],
  );
  const lineage = useStoreWithEqualityFn(useSessionStore, selectLineage, equal);
  if (!workspaceKey || !lineage) return null;
  return (
    <SidebarChatLineage workspaceKey={workspaceKey} lineage={lineage} indentStyle={indentStyle} />
  );
});

function SidebarChatLineage({
  workspaceKey,
  lineage,
  indentStyle,
}: {
  workspaceKey: string;
  lineage: SidebarLineage;
  indentStyle: StyleProp<ViewStyle>;
}) {
  // Hides a subagent the moment its archive is requested, as the track does. Only rows that have
  // something nested subscribe, so ordinary rows do not each open a query observer.
  const pendingArchive = usePendingArchiveAgentKeys();
  const workers = useMemo(
    () =>
      lineage.workers.filter(
        (worker) =>
          worker.kind !== "agent" || !pendingArchive.has(`${worker.serverId}:${worker.agentId}`),
      ),
    [lineage.workers, pendingArchive],
  );
  if (workers.length === 0) return null;
  return (
    <View testID={`sidebar-agent-lineage-${workspaceKey}`}>
      <SidebarWorkerList
        chatKey={`${lineage.serverId}:${lineage.agentId}`}
        workers={workers}
        indentStyle={indentStyle}
      />
    </View>
  );
}

/** Folds one chat's subagents into this one muted line. Other chats stay as they are. */
function SidebarLineageToggle({
  collapsed,
  onToggle,
  indentStyle,
  testID,
}: {
  collapsed: boolean;
  onToggle: () => void;
  indentStyle: StyleProp<ViewStyle>;
  testID: string;
}) {
  const { t } = useTranslation();
  const label = t("sidebar.lineage.label");
  return (
    <View style={[styles.lineage, indentStyle]}>
      <View style={styles.workspaceStatusSpacer} />
      <View style={styles.workers}>
        <PressHighlight
          accessibilityRole={isWeb ? undefined : "button"}
          accessibilityLabel={label}
          accessibilityState={collapsed ? COLLAPSED_STATE : EXPANDED_STATE}
          onPress={onToggle}
          style={toggleRowStyle}
          highlightStyle={styles.rowPressed}
          testID={testID}
        >
          <View style={styles.glyphSlot}>
            <View style={collapsed ? undefined : styles.chevronOpen}>
              <ThemedChevron size={12} uniProps={chevronColorMapping} />
            </View>
          </View>
          <Text style={styles.toggleText} numberOfLines={1}>
            {label}
          </Text>
        </PressHighlight>
      </View>
    </View>
  );
}

function SidebarWorkerList({
  chatKey,
  workers,
  indentStyle,
}: {
  chatKey: string;
  workers: SidebarLineageWorker[];
  indentStyle: StyleProp<ViewStyle>;
}) {
  const collapsed = useSidebarCollapsedSectionsStore((state) =>
    state.collapsedLineageKeys.has(chatKey),
  );
  const toggleLineageCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.toggleLineageCollapsed,
  );
  const toggleCollapsed = useCallback(
    () => toggleLineageCollapsed(chatKey),
    [toggleLineageCollapsed, chatKey],
  );
  if (workers.length === 0) return null;
  const toggle = (
    <SidebarLineageToggle
      collapsed={collapsed}
      onToggle={toggleCollapsed}
      indentStyle={indentStyle}
      testID={`sidebar-agent-lineage-toggle-${chatKey}`}
    />
  );
  if (collapsed) return toggle;
  return (
    <>
      {toggle}
      <View style={[styles.lineage, indentStyle]}>
        {/* Subagents sit on the chat title's rail: this spacer stands in for the status slot. */}
        <View style={styles.workspaceStatusSpacer} />
        <View style={styles.workers}>
          {workers.map((worker) => (
            <SidebarLineageWorkerRow key={workerKey(worker)} worker={worker} />
          ))}
        </View>
      </View>
    </>
  );
}

function SidebarLineageWorkerRow({ worker }: { worker: SidebarLineageWorker }) {
  const { t } = useTranslation();
  const open = useCallback(() => openWorker(worker), [worker]);
  const title = resolveRowLabel(worker.title) ?? t("common.states.loading");
  const status = t(SUBAGENT_STATUS_LABEL_KEYS[worker.bucket]);
  const id = worker.kind === "agent" ? worker.agentId : worker.subagentId;
  const labelTarget = useMemo<LabelTarget>(
    () =>
      worker.kind === "agent"
        ? { kind: "agent", agentId: worker.agentId }
        : { kind: "subagent", parentAgentId: worker.parentAgentId, subagentId: worker.subagentId },
    [worker],
  );
  return (
    <PressHighlight
      accessibilityRole={isWeb ? undefined : "button"}
      accessibilityLabel={`${title}, ${status}`}
      onPress={open}
      style={rowStyle}
      highlightStyle={styles.rowPressed}
      testID={`sidebar-agent-lineage-worker-${id}`}
    >
      <View style={styles.glyphSlot}>
        <ModelProviderGlyph
          provider={worker.provider}
          serverId={worker.serverId}
          size={PROVIDER_GLYPH_SIZE}
        />
      </View>
      <Text style={styles.workerTitle} numberOfLines={1}>
        {title}
      </Text>
      <LabelDots serverId={worker.serverId} target={labelTarget} />
      <SubagentStatusDot
        bucket={worker.bucket}
        testID={`sidebar-agent-lineage-status-${worker.bucket}`}
      />
      <Text style={styles.statusText} numberOfLines={1}>
        {status}
      </Text>
    </PressHighlight>
  );
}

function toggleRowStyle({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.toggleRow, hovered && !pressed && styles.rowHovered];
}

function rowStyle({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.row, hovered && !pressed && styles.rowHovered];
}

const styles = StyleSheet.create((theme) => ({
  lineage: {
    flexDirection: "row",
    paddingLeft: theme.spacing[2],
    gap: theme.spacing[2],
    marginBottom: theme.spacing[0.5],
  },
  workspaceStatusSpacer: {
    width: densityIconBox("md"),
    flexShrink: 0,
  },
  row: {
    flex: 1,
    minWidth: 0,
    minHeight: density.tightRowHeight,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
    paddingRight: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    userSelect: "none",
  },
  // Same rail as the subagent rows, shorter and quieter so it reads as a control, not an item.
  toggleRow: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingRight: theme.spacing[3],
    paddingVertical: theme.spacing[0.5],
    borderRadius: theme.borderRadius.md,
    userSelect: "none",
  },
  chevronOpen: {
    transform: [{ rotate: "90deg" }],
  },
  toggleText: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  rowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  // Subagents nest one level under the chat title's rail.
  workers: {
    flex: 1,
    minWidth: 0,
    paddingLeft: densityIconBox("sm"),
  },
  glyphSlot: {
    width: densityIconBox("sm"),
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  workerTitle: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  statusText: {
    flexShrink: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
