// Pimi addition to the Paseo fork. Apache-2.0.
import { useIsFocused } from "expo-router/react-navigation";
import { ArrowUpRight, ChevronLeft, ChevronRight, X } from "lucide-react-native";
import {
  memo,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AgentStreamView } from "@/agent-stream/view";
import { resolveAgentLabel } from "@/agent-presentation";
import { AgentStatusDot } from "@/components/agent-status-dot";
import { MenuHeader } from "@/components/headers/menu-header";
import { useProviderIcon } from "@/components/provider-icons";
import { DensityIcon } from "@/components/ui/density-icon";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { PimiAgentLabels } from "@/desktop/pimi-labels";
import { usePimiWorkspaceSection } from "@/desktop/pimi-console-content";
import { useAggregatedAgents, type AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { closePimiAgentGrid } from "@/navigation/pimi-agent-grid";
import { createPaneFocusContextValue, PaneFocusProvider } from "@/panels/pane-context";
import { useHostRuntimeConnectionStatus } from "@/runtime/host-runtime";
import { selectAgentTurnPresentation, useSessionStore } from "@/stores/session-store";
import type { PendingPermission } from "@/types/shared";
import type { StreamItem } from "@/types/stream";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { deriveSidebarStateBucket } from "@/utils/sidebar-agent-state";
import { useShallow } from "zustand/shallow";

type Filter = "active" | "all";
const filters: SegmentedControlOption<Filter>[] = [
  { value: "active", label: "Active" },
  { value: "all", label: "All" },
];
const EMPTY_STREAM: StreamItem[] = [];
const EMPTY_PERMISSIONS = new Map<string, PendingPermission>();
const GRID_PANE_FOCUS = createPaneFocusContextValue({
  isWorkspaceFocused: true,
  isPaneFocused: false,
});
const GridSpinner = withUnistyles(LoadingSpinner, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
// Limit concurrent timeline subscriptions to the panes that fit in one viewport.
const ROWS = 2;
const TILE_MIN_WIDTH = 340;
const MAX_COLUMNS = 3;
const GRID_BACKGROUND = { "pimi-agent-grid": "" };
const close = (
  <ToolbarButton label="Close agent grid" onPress={closePimiAgentGrid}>
    <DensityIcon icon={X} size="sm" color="foregroundMuted" />
  </ToolbarButton>
);

function lifecycle(agent: AggregatedAgent) {
  return agent.turn.phase === "open" ? "running" : agent.status;
}

function agentState(agent: AggregatedAgent) {
  const bucket = deriveSidebarStateBucket({ ...agent, status: lifecycle(agent) });
  if (bucket === "needs_input") return "Needs input";
  if (bucket === "running") return "Working";
  if (agent.status === "error") return "Failed";
  if (agent.status === "initializing") return "Starting";
  if (bucket === "attention") return "Finished";
  return agent.status === "closed" ? "Closed" : "Idle";
}

function isActiveAgent(agent: AggregatedAgent) {
  const state = agentState(agent);
  return state !== "Closed" && state !== "Idle";
}

export function PimiAgentGridScreen() {
  const focused = useIsFocused();
  const covered = usePimiWorkspaceSection() !== null;
  if (!focused || covered) return <View style={styles.screen} />;
  return (
    <PaneFocusProvider value={GRID_PANE_FOCUS}>
      <AgentGrid />
    </PaneFocusProvider>
  );
}

function AgentGrid() {
  const { agents, isInitialLoad } = useAggregatedAgents();
  const [filter, setFilter] = useState<Filter>("active");
  const [page, setPage] = useState(0);
  const [columns, setColumns] = useState(2);
  const ordered = useMemo(
    () =>
      agents
        .filter((agent) => filter === "all" || isActiveAgent(agent))
        .toSorted(
          (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id),
        ),
    [agents, filter],
  );
  const pageSize = columns * ROWS;
  const pages = Math.max(1, Math.ceil(ordered.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const tiles = ordered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const availableColumns = Math.floor(event.nativeEvent.layout.width / TILE_MIN_WIDTH);
    setColumns(Math.min(MAX_COLUMNS, Math.max(1, availableColumns)));
  }, []);
  const changeFilter = useCallback((value: Filter) => {
    setFilter(value);
    setPage(0);
  }, []);
  const previousPage = useCallback(() => setPage(currentPage - 1), [currentPage]);
  const nextPage = useCallback(() => setPage(currentPage + 1), [currentPage]);

  return (
    <View
      style={styles.screen}
      dataSet={GRID_BACKGROUND}
      testID="pimi-agent-grid"
      onLayout={handleLayout}
    >
      <MenuHeader title="Agent grid" rightContent={close} />
      <View style={styles.controls}>
        <SegmentedControl options={filters} value={filter} onValueChange={changeFilter} />
        {pages > 1 ? (
          <View style={styles.pagination}>
            <ToolbarButton
              label="Previous agents"
              disabled={currentPage === 0}
              onPress={previousPage}
            >
              <DensityIcon icon={ChevronLeft} size="sm" color="foregroundMuted" />
            </ToolbarButton>
            <Text style={styles.metadata}>
              {currentPage + 1} / {pages}
            </Text>
            <ToolbarButton
              label="Next agents"
              disabled={currentPage === pages - 1}
              onPress={nextPage}
            >
              <DensityIcon icon={ChevronRight} size="sm" color="foregroundMuted" />
            </ToolbarButton>
          </View>
        ) : null}
      </View>
      {tiles.length ? (
        <View style={styles.grid}>
          {Array.from({ length: Math.ceil(tiles.length / columns) }, (_, row) => (
            <View key={row} style={styles.row}>
              {tiles.slice(row * columns, (row + 1) * columns).map((agent) => (
                <AgentTile key={JSON.stringify([agent.serverId, agent.id])} agent={agent} />
              ))}
            </View>
          ))}
        </View>
      ) : (
        <View style={styles.empty}>
          {isInitialLoad ? (
            <GridSpinner />
          ) : (
            <Text style={styles.metadata}>
              {filter === "active" ? "No active agents." : "No agent conversations yet."}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

const AgentTile = memo(function AgentTile({ agent }: { agent: AggregatedAgent }) {
  const { serverId, id } = agent;
  const sourceId = useId();
  const connection = useHostRuntimeConnectionStatus(serverId);
  const providerIcon = useProviderIcon(agent.provider, serverId);
  const { sync, items, ready } = useSessionStore(
    useShallow((state) => {
      const session = state.sessions[serverId];
      return {
        sync: session?.viewedTimelineSync,
        items: session?.agentStreamTail.get(id) ?? EMPTY_STREAM,
        ready: session?.agentAuthoritativeHistoryApplied.get(id) === true,
      };
    }),
  );
  const turnPresentation = useSessionStore(
    useShallow((state) => selectAgentTurnPresentation(state.sessions[serverId], id)),
  );
  useLayoutEffect(() => {
    // The viewed timeline owner prepares the replica and releases stream demand when this pane leaves.
    sync?.replaceVisibleAgentIds(sourceId, [id]);
    return () => sync?.replaceVisibleAgentIds(sourceId, []);
  }, [id, sourceId, sync]);
  const subscribe = useCallback(
    (listener: () => void) => sync?.subscribe(listener) ?? (() => {}),
    [sync],
  );
  const readStatus = useCallback(() => sync?.getAgentTimelineStatus(id) ?? "pending", [id, sync]);
  const timelineStatus = useSyncExternalStore(subscribe, readStatus, readStatus);
  const context = useMemo(
    () => ({
      serverId,
      id,
      status: agent.status,
      cwd: agent.cwd,
      provider: agent.provider,
      workspaceId: agent.workspaceId,
      projectPlacement: agent.projectPlacement,
    }),
    [
      serverId,
      id,
      agent.status,
      agent.cwd,
      agent.provider,
      agent.workspaceId,
      agent.projectPlacement,
    ],
  );
  const anchor = useMemo(
    () => ({ reason: "initial-entry" as const, agentId: id, requestKey: sourceId }),
    [id, sourceId],
  );
  const openChat = useCallback(() => {
    navigateToAgent({ serverId, agentId: id, workspaceId: agent.workspaceId });
  }, [agent.workspaceId, id, serverId]);
  const title = resolveAgentLabel(agent.title) ?? `${agent.provider} agent`;
  const online = connection === "online";
  const connectionLabel = connection === "connecting" ? "Connecting" : "Offline";
  return (
    <View style={styles.tile} testID={`pimi-agent-grid-tile-${id}`}>
      <View style={styles.tileHeader}>
        <DensityIcon icon={providerIcon} size="sm" color="foregroundMuted" />
        <View style={styles.titleGroup}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.metadata} numberOfLines={1}>
            {[
              agent.projectPlacement?.projectName,
              agent.projectPlacement?.workspaceName,
              agent.serverLabel,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        </View>
        <View style={styles.status}>
          {online ? (
            <AgentStatusDot
              status={lifecycle(agent)}
              requiresAttention={agent.requiresAttention}
              attentionReason={agent.attentionReason}
              pendingPermissionCount={agent.pendingPermissionCount}
            />
          ) : null}
          <Text style={styles.metadata}>{online ? agentState(agent) : connectionLabel}</Text>
        </View>
        <ToolbarButton label={`Open ${title}`} onPress={openChat}>
          <DensityIcon icon={ArrowUpRight} size="sm" color="foregroundMuted" />
        </ToolbarButton>
      </View>
      <PimiAgentLabels serverId={serverId} workspaceId={agent.workspaceId} agentId={id} />
      <View style={styles.transcript}>
        <AgentStreamView
          agentId={id}
          serverId={serverId}
          context={context}
          streamItems={items}
          pendingPermissions={EMPTY_PERMISSIONS}
          turnPresentation={turnPresentation}
          readOnly
          isAuthoritativeHistoryReady={ready || !online}
          routeBottomAnchorRequest={anchor}
        />
        {online && !ready && timelineStatus !== "ready" ? (
          <View style={styles.loading} pointerEvents="none">
            {timelineStatus === "error" ? (
              <Text style={styles.metadata}>Open the conversation to retry.</Text>
            ) : (
              <GridSpinner />
            )}
          </View>
        ) : null}
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 },
  controls: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  pagination: { flexDirection: "row", gap: theme.spacing[2], alignItems: "center" },
  grid: {
    flex: 1,
    minHeight: 0,
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
  row: { flex: 1, minHeight: 0, flexDirection: "row", gap: theme.spacing[2] },
  tile: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface0,
  },
  tileHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  titleGroup: { flex: 1, minWidth: 0 },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  metadata: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  status: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  transcript: { flex: 1, minHeight: 0 },
  loading: {
    position: "absolute",
    top: 6,
    right: 8,
    padding: theme.spacing[1],
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.sm,
  },
  empty: { flex: 1, alignItems: "center", justifyContent: "center" },
}));
