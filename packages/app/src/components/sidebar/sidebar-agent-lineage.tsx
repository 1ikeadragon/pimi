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
import equal from "fast-deep-equal";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { create } from "zustand";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { ModelProviderGlyph } from "@/components/model-browser";
import { DensityIcon } from "@/components/ui/density-icon";
import { PressHighlight } from "@/components/ui/press-highlight";
import { isWeb } from "@/constants/platform";
import { getDesktopHost } from "@/desktop/host";
import { usePendingArchiveAgentKeys } from "@/hooks/use-archive-agent";
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
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { aggregateSidebarStateBuckets, type SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { STATUS_INDICATOR_FILLED_DOT_SIZE } from "@/utils/status-indicator-geometry";

const PROVIDER_GLYPH_SIZE = 14;

/**
 * The user's expand/collapse choice per chat, for this app session. Absent means expanded: every
 * child listed here is live, so it is worth showing until the user folds it. Kept outside the row
 * so a virtualized sidebar that remounts the row keeps the choice.
 */
const useLineageExpansionStore = create<{
  expanded: Readonly<Record<string, boolean>>;
  setExpanded: (key: string, expanded: boolean) => void;
}>((set) => ({
  expanded: {},
  setExpanded: (key, expanded) =>
    set((state) => ({ expanded: { ...state.expanded, [key]: expanded } })),
}));

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

/**
 * The chats in one workspace that have live subagents, each with those subagents indented under
 * it. Renders nothing for a workspace without any, which is almost every row, so the cost there
 * is one shared-index lookup per session-store update.
 */
export const SidebarAgentLineage = memo(function SidebarAgentLineage({
  serverId,
  workspaceId,
  indentStyle,
}: {
  serverId: string | null | undefined;
  workspaceId: string;
  /** The workspace row's own indent, so the chats keep its title rail in every grouping. */
  indentStyle?: StyleProp<ViewStyle>;
}): ReactElement | null {
  const workspaceKey = serverId ? sidebarLineageWorkspaceKey(serverId, workspaceId) : null;
  const descriptors = useProviderSubagentStore((state) => state.descriptors);
  const hiddenFromTrack = useProviderSubagentStore((state) => state.hiddenFromTrack);
  const selectChats = useCallback(
    (state: ReturnType<typeof useSessionStore.getState>) =>
      workspaceKey
        ? selectSidebarLineageChats(state.sessions, { descriptors, hiddenFromTrack }, workspaceKey)
        : null,
    [workspaceKey, descriptors, hiddenFromTrack],
  );
  const chats = useStoreWithEqualityFn(useSessionStore, selectChats, equal);
  if (!chats?.length || !workspaceKey) return null;
  return (
    <SidebarAgentLineageChats workspaceKey={workspaceKey} chats={chats} indentStyle={indentStyle} />
  );
});

function SidebarAgentLineageChats({
  workspaceKey,
  chats,
  indentStyle,
}: {
  workspaceKey: string;
  chats: SidebarLineageChat[];
  indentStyle: StyleProp<ViewStyle>;
}) {
  // Hides a subagent the moment its archive is requested, as the track does. Only rows that
  // have lineage subscribe, so ordinary workspace rows do not each open a query observer.
  const pendingArchive = usePendingArchiveAgentKeys();
  const visibleChats = useMemo(() => {
    if (pendingArchive.size === 0) return chats;
    return chats.flatMap((chat) => {
      if (pendingArchive.has(`${chat.serverId}:${chat.agentId}`)) return [];
      const workers = chat.workers.filter(
        (worker) =>
          worker.kind !== "agent" || !pendingArchive.has(`${worker.serverId}:${worker.agentId}`),
      );
      if (workers.length === 0) return [];
      return [workers.length === chat.workers.length ? chat : { ...chat, workers }];
    });
  }, [chats, pendingArchive]);
  if (visibleChats.length === 0) return null;
  return (
    <View style={[styles.lineage, indentStyle]} testID={`sidebar-agent-lineage-${workspaceKey}`}>
      {/* The chats sit on the workspace title's rail: this spacer stands in for the status slot. */}
      <View style={styles.workspaceStatusSpacer} />
      <View style={styles.chatColumn}>
        {visibleChats.map((chat) => (
          <SidebarLineageChatGroup key={`${chat.serverId}:${chat.agentId}`} chat={chat} />
        ))}
      </View>
    </View>
  );
}

function SidebarLineageChatGroup({ chat }: { chat: SidebarLineageChat }) {
  const { t } = useTranslation();
  const chatKey = `${chat.serverId}:${chat.agentId}`;
  const choice = useLineageExpansionStore((state) => state.expanded[chatKey]);
  const expanded = choice ?? true;
  const toggle = useCallback(() => {
    useLineageExpansionStore.getState().setExpanded(chatKey, !expanded);
  }, [chatKey, expanded]);
  const open = useCallback(() => openAgent(chat), [chat]);
  // The chat's own state is literal, so its dot also carries what its subagents are doing —
  // collapsed, it is the only place their state still shows.
  const groupBucket = useMemo(
    () => aggregateSidebarStateBuckets([chat.bucket, ...chat.workers.map((w) => w.bucket)]),
    [chat],
  );
  const title = resolveRowLabel(chat.title) ?? t("common.states.loading");
  const toggleLabel = t("subagents.title");
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);

  return (
    <View>
      <View style={styles.rowLine}>
        <PressHighlight
          accessibilityRole={isWeb ? undefined : "button"}
          accessibilityLabel={toggleLabel}
          accessibilityState={accessibilityState}
          onPress={toggle}
          style={chevronStyle}
          highlightStyle={styles.rowPressed}
          testID={`sidebar-agent-lineage-toggle-${chat.agentId}`}
        >
          {({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => (
            <DensityIcon
              icon={expanded ? ChevronDown : ChevronRight}
              size="sm"
              color={hovered || pressed ? "foreground" : "foregroundMuted"}
            />
          )}
        </PressHighlight>
        <PressHighlight
          accessibilityRole={isWeb ? undefined : "button"}
          accessibilityLabel={title}
          onPress={open}
          style={rowStyle}
          highlightStyle={styles.rowPressed}
          testID={`sidebar-agent-lineage-chat-${chat.agentId}`}
        >
          <Text style={styles.chatTitle} numberOfLines={1}>
            {title}
          </Text>
          {expanded ? null : <Text style={styles.statusText}>{chat.workers.length}</Text>}
          <LineageStatusDot bucket={groupBucket} />
        </PressHighlight>
      </View>
      {expanded ? (
        <View style={styles.workers}>
          {chat.workers.map((worker) => (
            <SidebarLineageWorkerRow key={workerKey(worker)} worker={worker} />
          ))}
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

function chevronStyle({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.chevron, hovered && !pressed && styles.rowHovered];
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
  chatColumn: {
    flex: 1,
    minWidth: 0,
  },
  rowLine: {
    flexDirection: "row",
    alignItems: "center",
  },
  chevron: {
    width: densityIconBox("sm"),
    minHeight: density.tightRowHeight,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
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
  rowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  // Subagents start on the chat title's rail: one chevron slot in.
  workers: {
    paddingLeft: densityIconBox("sm"),
  },
  glyphSlot: {
    width: densityIconBox("sm"),
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  chatTitle: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    opacity: 0.76,
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
