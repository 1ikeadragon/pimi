import { memo, useCallback, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "@/i18n/use-translation";
import {
  Text,
  View,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import equal from "fast-deep-equal";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { ModelProviderGlyph } from "@/components/model-browser";
import { LabelDots } from "@/labels/target-chips";
import type { LabelTarget } from "@pimi/protocol/labels";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { getDesktopHost } from "@/desktop/host";
import { useArchiveAgent, usePendingArchiveAgentKeys } from "@/hooks/use-archive-agent";
import { SidebarWorkspaceArchiveButton } from "@/components/sidebar/sidebar-workspace-menu";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { usePanelStore } from "@/stores/panel-store";
import { useSessionStore } from "@/stores/session-store";
import { density, densityIconBox } from "@/styles/density";
import { useProviderSubagentStore } from "@/subagents/provider-store";
import {
  selectSidebarLineageChats,
  sidebarLineageWorkspaceKey,
  type SidebarLineageChat,
  type SidebarLineageWorker,
} from "@/subagents/sidebar-lineage";
import { SUBAGENT_STATUS_LABEL_KEYS } from "@/subagents/status";
import { SubagentStatusDot } from "@/subagents/status-dot";
import { resolveRowLabel } from "@/subagents/track-presentation";
import {
  resolveChatTitle,
  useWorkspaceRootChats,
  useWorkspaceShownChat,
  type WorkspaceRootChat,
} from "@/chats/primary-chat";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { STATUS_INDICATOR_FILLED_DOT_SIZE } from "@/utils/status-indicator-geometry";

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

const EMPTY_WORKERS: SidebarLineageWorker[] = [];

/**
 * What hangs under a workspace's chat row: the live subagents of its primary chat, then every
 * further root chat as a full peer row of its own (opening that chat, highlighted while it is the
 * one shown, archived on its own), each followed by its subagents. Renders nothing for the common single-chat workspace without subagents, so the cost there is
 * two shared-index lookups per session-store update.
 */
export const SidebarAgentLineage = memo(function SidebarAgentLineage({
  serverId,
  workspaceId,
  workspaceSelected = false,
  indentStyle,
}: {
  serverId: string | null | undefined;
  workspaceId: string;
  /** The workspace is on screen, so the row of the chat being shown highlights. */
  workspaceSelected?: boolean;
  /** The workspace row's own indent, so nested rows keep its title rail in every grouping. */
  indentStyle?: StyleProp<ViewStyle>;
}): ReactElement | null {
  const workspaceKey = serverId ? sidebarLineageWorkspaceKey(serverId, workspaceId) : null;
  const descriptors = useProviderSubagentStore((state) => state.descriptors);
  const hiddenFromTrack = useProviderSubagentStore((state) => state.hiddenFromTrack);
  const selectLineage = useCallback(
    (state: ReturnType<typeof useSessionStore.getState>) =>
      workspaceKey
        ? selectSidebarLineageChats(state.sessions, { descriptors, hiddenFromTrack }, workspaceKey)
        : null,
    [workspaceKey, descriptors, hiddenFromTrack],
  );
  const lineage = useStoreWithEqualityFn(useSessionStore, selectLineage, equal);
  const roots = useWorkspaceRootChats(serverId, workspaceId);
  if (!workspaceKey || (roots.length < 2 && !lineage?.length)) return null;
  return (
    <SidebarChatTree
      serverId={serverId}
      workspaceId={workspaceId}
      workspaceKey={workspaceKey}
      roots={roots}
      lineage={lineage ?? []}
      workspaceSelected={workspaceSelected}
      indentStyle={indentStyle}
    />
  );
});

function SidebarChatTree({
  serverId,
  workspaceId,
  workspaceKey,
  roots,
  lineage,
  workspaceSelected,
  indentStyle,
}: {
  serverId: string | null | undefined;
  workspaceId: string;
  workspaceKey: string;
  roots: WorkspaceRootChat[];
  lineage: SidebarLineageChat[];
  workspaceSelected: boolean;
  indentStyle: StyleProp<ViewStyle>;
}) {
  // Hides a chat or subagent the moment its archive is requested, as the track does. Only rows
  // that have something nested subscribe, so ordinary rows do not each open a query observer.
  const pendingArchive = usePendingArchiveAgentKeys();
  const workersByChat = useMemo(() => {
    const byChat = new Map<string, SidebarLineageWorker[]>();
    for (const chat of lineage) {
      byChat.set(
        chat.agentId,
        chat.workers.filter(
          (worker) =>
            worker.kind !== "agent" || !pendingArchive.has(`${worker.serverId}:${worker.agentId}`),
        ),
      );
    }
    return byChat;
  }, [lineage, pendingArchive]);
  const siblings = useMemo(
    () => roots.slice(1).filter((chat) => !pendingArchive.has(`${chat.serverId}:${chat.agentId}`)),
    [roots, pendingArchive],
  );
  const primary = roots[0];
  const shown = useWorkspaceShownChat(serverId, workspaceId);
  const primaryWorkers = (primary && workersByChat.get(primary.agentId)) || EMPTY_WORKERS;
  return (
    <View testID={`sidebar-agent-lineage-${workspaceKey}`}>
      <SidebarWorkerList workers={primaryWorkers} indentStyle={indentStyle} />
      {siblings.map((chat) => (
        <View key={`${chat.serverId}:${chat.agentId}`}>
          <SidebarSiblingChatRow
            chat={chat}
            selected={workspaceSelected && shown?.agentId === chat.agentId}
            indentStyle={indentStyle}
          />
          <SidebarWorkerList
            workers={workersByChat.get(chat.agentId) ?? EMPTY_WORKERS}
            indentStyle={indentStyle}
          />
        </View>
      ))}
    </View>
  );
}

function SidebarWorkerList({
  workers,
  indentStyle,
}: {
  workers: SidebarLineageWorker[];
  indentStyle: StyleProp<ViewStyle>;
}) {
  if (workers.length === 0) return null;
  return (
    <View style={[styles.lineage, indentStyle]}>
      {/* Subagents sit on the chat title's rail: this spacer stands in for the status slot. */}
      <View style={styles.workspaceStatusSpacer} />
      <View style={styles.workers}>
        {workers.map((worker) => (
          <SidebarLineageWorkerRow key={workerKey(worker)} worker={worker} />
        ))}
      </View>
    </View>
  );
}

/** A further root chat in the same workspace, as its own row at the workspace row's indent. */
function SidebarSiblingChatRow({
  chat,
  selected,
  indentStyle,
}: {
  chat: WorkspaceRootChat;
  selected: boolean;
  indentStyle: StyleProp<ViewStyle>;
}) {
  const open = useCallback(() => openAgent(chat), [chat]);
  const { archiveAgent } = useArchiveAgent();
  const [hovered, setHovered] = useState(false);
  // Touch and compact layouts have no hover, so the button is always there.
  const isCompact = useIsCompactFormFactor();
  const showArchive = hovered || !isWeb || isCompact;
  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);
  // Archives only this chat; the workspace's other chats and its record stay.
  const archive = useCallback(
    () => void archiveAgent({ serverId: chat.serverId, agentId: chat.agentId }),
    [archiveAgent, chat.serverId, chat.agentId],
  );
  // Mirrors the workspace row's archive shortcut for the chat that is on screen.
  useKeyboardActionHandler({
    handlerId: `chat-archive-${chat.agentId}`,
    actions: ["workspace.archive"],
    enabled: selected,
    priority: 0,
    handle: () => {
      archive();
      return true;
    },
  });
  const siblingLabelTarget = useMemo<LabelTarget>(
    () => ({ kind: "agent", agentId: chat.agentId }),
    [chat.agentId],
  );
  const title = resolveChatTitle({
    primaryTitle: chat.title,
    workspaceTitle: null,
    fallback: "New chat",
  });
  return (
    <View
      style={[styles.siblingChat, indentStyle]}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <PressHighlight
        accessibilityRole={isWeb ? undefined : "button"}
        accessibilityLabel={title}
        onPress={open}
        style={selected ? siblingSelectedRowStyle : siblingRowStyle}
        highlightStyle={styles.rowPressed}
        testID={`sidebar-chat-row-${chat.agentId}`}
      >
        <View style={styles.siblingStatusSlot}>
          <LineageStatusDot bucket={chat.bucket} />
        </View>
        <Text style={styles.siblingTitle} numberOfLines={1}>
          {title}
        </Text>
        <LabelDots serverId={chat.serverId} target={siblingLabelTarget} />
      </PressHighlight>
      {showArchive ? (
        <View style={styles.siblingArchive}>
          <SidebarWorkspaceArchiveButton workspaceKey={chat.agentId} onArchive={archive} />
        </View>
      ) : null}
    </View>
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

/** The chat's own dot: its workspace-row state folded with its children's. */
function LineageStatusDot({ bucket }: { bucket: SidebarStateBucket }) {
  return <View style={dotStyleFor(bucket)} testID={`sidebar-agent-lineage-status-${bucket}`} />;
}

function siblingRowStyle({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.siblingRow, hovered && !pressed && styles.rowHovered];
}

function siblingSelectedRowStyle({
  hovered,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.siblingRow, styles.rowSelected, hovered && !pressed && styles.rowHovered];
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
  siblingChat: {
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: theme.spacing[2],
    marginBottom: theme.spacing[0.5],
  },
  siblingArchive: {
    paddingHorizontal: theme.spacing[2],
  },
  siblingRow: {
    flex: 1,
    minWidth: 0,
    minHeight: density.tightRowHeight,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingRight: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    userSelect: "none",
  },
  siblingStatusSlot: {
    width: densityIconBox("md"),
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  siblingTitle: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    opacity: 0.76,
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
  rowSelected: {
    backgroundColor: theme.colors.surfaceSidebarSelected,
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
  dotNeedsInput: {
    width: STATUS_INDICATOR_FILLED_DOT_SIZE,
    height: STATUS_INDICATOR_FILLED_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    flexShrink: 0,
    backgroundColor: getStatusDotColor({ theme, bucket: "needs_input" }) ?? undefined,
  },
  dotFailed: {
    width: STATUS_INDICATOR_FILLED_DOT_SIZE,
    height: STATUS_INDICATOR_FILLED_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    flexShrink: 0,
    backgroundColor: getStatusDotColor({ theme, bucket: "failed" }) ?? undefined,
  },
  dotRunning: {
    width: STATUS_INDICATOR_FILLED_DOT_SIZE,
    height: STATUS_INDICATOR_FILLED_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    flexShrink: 0,
    backgroundColor: getStatusDotColor({ theme, bucket: "running" }) ?? undefined,
  },
  dotAttention: {
    width: STATUS_INDICATOR_FILLED_DOT_SIZE,
    height: STATUS_INDICATOR_FILLED_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    flexShrink: 0,
    backgroundColor: getStatusDotColor({ theme, bucket: "attention" }) ?? undefined,
  },
  // Idle holds the slot with the same muted dot an idle workspace row uses.
  dotIdle: {
    width: STATUS_INDICATOR_FILLED_DOT_SIZE,
    height: STATUS_INDICATOR_FILLED_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    flexShrink: 0,
    backgroundColor: theme.colors.foregroundExtraMuted,
    opacity: 0.3,
  },
}));

function dotStyleFor(bucket: SidebarStateBucket) {
  switch (bucket) {
    case "needs_input":
      return styles.dotNeedsInput;
    case "failed":
      return styles.dotFailed;
    case "running":
      return styles.dotRunning;
    case "attention":
      return styles.dotAttention;
    case "done":
      return styles.dotIdle;
  }
}
