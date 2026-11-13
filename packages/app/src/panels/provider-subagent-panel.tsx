import { useCallback, useEffect, useMemo, useState, type ComponentProps } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { invariant } from "@/utils/invariant";
import { useShallow } from "zustand/react/shallow";
import { AgentStreamView } from "@/agent-stream/view";
import { useProviderIcon } from "@/components/provider-icons";
import {
  resolveComposerTrackControlClearance,
  resolveComposerTrackTailClearance,
} from "@/composer/pill-styles";
import { ComposerTrackBar } from "@/composer/tracks";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { AgentScreenAgent } from "@/hooks/use-agent-screen-state-machine";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import { PaneSubtitle } from "@/panels/pane-subtitle";
import { definePanel, type PanelDescriptor } from "@/panels/panel-registry";
import { useSessionStore } from "@/stores/session-store";
import type { SheetTab } from "@/stores/workspace-layout-store";
import { canMessageProviderSubagent } from "@pimi/protocol/provider-subagent-messaging";
import { ComposerDock } from "@/composer/dock";
import { useComposerEditingSession, useComposerFullscreen } from "@/composer/editing-session";
import {
  ProviderSubagentComposer,
  ProviderSubagentComposerUnavailable,
} from "@/panels/provider-subagent-composer";
import { ParentAgentPill } from "@/subagents/parent";
import { type SubagentRow, useSubagentsForParent } from "@/subagents/select";
import { useSubagentSheetTab } from "@/subagents/sheet-tab";
import { SubagentsTrack } from "@/subagents/track";
import {
  providerSubagentKey,
  providerSubagentLifecycleStatus,
  refreshProviderSubagents,
  observeProviderSubagentTimeline,
  useProviderSubagentStore,
} from "@/subagents/provider-store";
import type { PendingPermission } from "@/types/shared";
import type { StreamItem } from "@/types/stream";
import { providerSubagentStatusBucket } from "@/subagents";
import { TIMELINE_FETCH_PAGE_SIZE } from "@/timeline/timeline-fetch-policy";
import type { TurnPresentation } from "@/timeline/turn-liveness";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

const EMPTY_PERMISSIONS = new Map<string, PendingPermission>();
const EMPTY_STREAM_ITEMS: StreamItem[] = [];
const NOOP_SUBAGENT = () => undefined;

function resolveChildTrackClearance(hasTrack: boolean, isCompact: boolean) {
  if (!hasTrack) return { tail: 0, controls: 0 };
  return {
    tail: resolveComposerTrackTailClearance(isCompact),
    controls: resolveComposerTrackControlClearance(isCompact),
  };
}

function ProviderSubagentChildTrack({
  serverId,
  parentAgentId,
  showParentPill,
  rows,
  onOpenProviderSubagent,
  sheetTabFor,
}: {
  serverId: string;
  parentAgentId: string;
  showParentPill: boolean;
  rows: ReturnType<typeof useSubagentsForParent>;
  onOpenProviderSubagent: (parentAgentId: string, subagentId: string) => void;
  sheetTabFor: (row: SubagentRow) => SheetTab | null;
}) {
  if (rows.length === 0 && !showParentPill) return null;
  return (
    <ComposerTrackBar>
      {showParentPill ? (
        <ParentAgentPill serverId={serverId} parentAgentId={parentAgentId} />
      ) : null}
      <SubagentsTrack
        serverId={serverId}
        rows={rows}
        onOpenSubagent={NOOP_SUBAGENT}
        onOpenProviderSubagent={onOpenProviderSubagent}
        sheetTabFor={sheetTabFor}
        onArchiveSubagent={NOOP_SUBAGENT}
      />
    </ComposerTrackBar>
  );
}

function formatProviderLabel(provider: string): string {
  return provider
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function useProviderSubagentDescriptor(
  target: { kind: "provider_subagent"; parentAgentId: string; subagentId: string },
  context: { serverId: string },
): PanelDescriptor {
  const descriptor = useProviderSubagentStore((state) =>
    state.descriptors.get(
      providerSubagentKey(context.serverId, target.parentAgentId, target.subagentId),
    ),
  );
  const parentProvider = useSessionStore(
    (state) => state.sessions[context.serverId]?.agents.get(target.parentAgentId)?.provider,
  );
  const provider = descriptor?.provider ?? parentProvider ?? "agent";
  // The task names the tab; the subagent type is supporting detail beside the provider.
  const subagentType = descriptor?.title?.trim();
  const label = descriptor?.description?.trim() || subagentType || "Subagent";
  const providerLabel = `${formatProviderLabel(provider)} subagent`;
  return {
    label,
    subtitle:
      subagentType && subagentType !== label ? `${subagentType} · ${providerLabel}` : providerLabel,
    tooltip: label,
    titleState: descriptor ? "ready" : "loading",
    icon: useProviderIcon(provider, context.serverId),
    statusBucket: descriptor ? providerSubagentStatusBucket(descriptor.status) : null,
  };
}

function resolveSubagentProvider(
  descriptor: { provider?: string } | null,
  parent: { provider?: string } | null,
): string | null {
  return descriptor?.provider ?? parent?.provider ?? null;
}

function resolveSubagentCwd(
  descriptor: { cwd?: string | null } | null,
  parent: { cwd?: string | null } | null,
): string {
  return descriptor?.cwd ?? parent?.cwd ?? "";
}

function ProviderSubagentFooter({
  serverId,
  parentAgentId,
  subagentId,
  streamId,
  provider,
  cwd,
  isPaneFocused,
  editingSession,
}: {
  serverId: string;
  parentAgentId: string;
  subagentId: string;
  streamId: string;
  provider: string | null;
  cwd: string;
  isPaneFocused: boolean;
  editingSession: ComponentProps<typeof ProviderSubagentComposer>["editingSession"];
}) {
  if (provider !== null && canMessageProviderSubagent(provider)) {
    return (
      <ProviderSubagentComposer
        serverId={serverId}
        parentAgentId={parentAgentId}
        subagentId={subagentId}
        streamId={streamId}
        cwd={cwd}
        isPaneFocused={isPaneFocused}
        editingSession={editingSession}
      />
    );
  }
  return (
    <ProviderSubagentComposerUnavailable
      serverId={serverId}
      parentAgentId={parentAgentId}
      provider={formatProviderLabel(provider ?? "agent")}
    />
  );
}

function ProviderSubagentPanel() {
  const { serverId, workspaceId, tabId, target, openFileInWorkspace, openTab } = usePaneContext();
  const { isPaneFocused } = usePaneFocus();
  const editingSession = useComposerEditingSession("chat");
  const isComposerFullscreen = useComposerFullscreen(editingSession);
  invariant(target.kind === "provider_subagent", "ProviderSubagentPanel requires provider target");
  const key = providerSubagentKey(serverId, target.parentAgentId, target.subagentId);
  const streamId = `provider:${encodeURIComponent(target.parentAgentId)}:${encodeURIComponent(target.subagentId)}`;
  const { descriptor, timeline } = useProviderSubagentStore(
    useShallow((state) => ({
      descriptor: state.descriptors.get(key) ?? null,
      timeline: state.timelines.get(key) ?? null,
    })),
  );
  const parent = useSessionStore(
    (state) =>
      state.sessions[serverId]?.agents.get(target.parentAgentId) ??
      state.sessions[serverId]?.agentDetails.get(target.parentAgentId) ??
      null,
  );
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const isCompact = useIsCompactFormFactor();
  const childRows = useSubagentsForParent({
    serverId,
    parentAgentId: target.parentAgentId,
    providerParentSubagentId: target.subagentId,
  });
  const provider = resolveSubagentProvider(descriptor, parent);
  const canMessage = provider !== null && canMessageProviderSubagent(provider);
  const childTrackClearance = resolveChildTrackClearance(
    childRows.length > 0 || canMessage,
    isCompact,
  );
  const sheetTabFor = useSubagentSheetTab(
    buildWorkspaceTabPersistenceKey({ serverId, workspaceId }),
    tabId,
  );
  const openProviderChild = useCallback(
    (parentAgentId: string, subagentId: string) => {
      openTab({ kind: "provider_subagent", parentAgentId, subagentId });
    },
    [openTab],
  );

  useEffect(() => {
    if (!client) return;
    void refreshProviderSubagents(client, serverId, target.parentAgentId).catch(() => undefined);
  }, [client, serverId, target.parentAgentId]);

  useEffect(() => {
    if (!client) return;
    return observeProviderSubagentTimeline({
      client,
      serverId,
      parentAgentId: target.parentAgentId,
      subagentId: target.subagentId,
      limit: TIMELINE_FETCH_PAGE_SIZE,
      reportError: (error) => {
        console.error("[ProviderSubagentTimeline] Failed to refresh child history", {
          error,
          serverId,
          parentAgentId: target.parentAgentId,
          subagentId: target.subagentId,
        });
      },
    });
  }, [client, serverId, target.parentAgentId, target.subagentId]);

  const loadOlder = useCallback((): boolean => {
    if (!client || isLoadingOlder || !timeline?.hasOlder || !timeline.epoch) {
      return false;
    }
    const firstSeq = timeline.cursor?.startSeq ?? null;
    if (firstSeq === null) return false;
    setIsLoadingOlder(true);
    void client
      .fetchProviderSubagentTimeline(target.parentAgentId, target.subagentId, {
        direction: "before",
        cursor: { epoch: timeline.epoch, seq: firstSeq },
        limit: TIMELINE_FETCH_PAGE_SIZE,
      })
      .then((payload) => {
        useProviderSubagentStore.getState().replaceTimeline(serverId, payload);
        return undefined;
      })
      .catch(() => undefined)
      .finally(() => setIsLoadingOlder(false));
    return true;
  }, [client, isLoadingOlder, serverId, target.parentAgentId, target.subagentId, timeline]);
  const firstTimelineSeq = timeline?.cursor?.startSeq ?? null;
  const progressKey =
    timeline?.epoch && firstTimelineSeq !== null ? `${timeline.epoch}:${firstTimelineSeq}` : null;
  const subtitle = descriptor?.subtitle?.trim();

  const streamContext = useMemo<AgentScreenAgent>(
    () => ({
      serverId,
      id: streamId,
      provider: descriptor?.provider ?? parent?.provider,
      status: descriptor ? providerSubagentLifecycleStatus(descriptor.status) : "initializing",
      cwd: descriptor?.cwd ?? parent?.cwd ?? "",
      workspaceId: parent?.workspaceId,
      projectPlacement: parent?.projectPlacement,
    }),
    [descriptor, parent, serverId, streamId],
  );
  const historyPagination = useMemo(
    () => ({
      hasOlder: timeline?.hasOlder === true,
      isLoadingOlder,
      progressKey,
      onLoadOlder: loadOlder,
    }),
    [isLoadingOlder, loadOlder, progressKey, timeline?.hasOlder],
  );
  const turnPresentation = useMemo<TurnPresentation>(
    () => ({
      isActive: descriptor?.status === "running",
      isCancelling: false,
      startedAt: null,
      turnId: null,
    }),
    [descriptor?.status],
  );

  const stream = (
    <View style={styles.stream}>
      <AgentStreamView
        agentId={streamId}
        imageAgentId={target.parentAgentId}
        serverId={serverId}
        context={streamContext}
        streamItems={timeline?.tail ?? EMPTY_STREAM_ITEMS}
        streamHead={timeline?.head ?? EMPTY_STREAM_ITEMS}
        turnPresentation={turnPresentation}
        pendingPermissions={EMPTY_PERMISSIONS}
        isAuthoritativeHistoryReady
        onOpenWorkspaceFile={openFileInWorkspace}
        readOnly
        historyPagination={historyPagination}
        bottomOverlayTailClearance={childTrackClearance.tail}
        bottomOverlayControlClearance={childTrackClearance.controls}
      />
      <ProviderSubagentChildTrack
        serverId={serverId}
        parentAgentId={target.parentAgentId}
        showParentPill={canMessage}
        rows={childRows}
        onOpenProviderSubagent={openProviderChild}
        sheetTabFor={sheetTabFor}
      />
    </View>
  );
  const content = (
    <View style={styles.stream}>
      {subtitle ? <PaneSubtitle text={subtitle} testID="provider-subagent-pane-subtitle" /> : null}
      {stream}
    </View>
  );

  return (
    <View style={styles.container} testID="provider-subagent-panel">
      <ComposerDock fullscreen={isComposerFullscreen}>
        {content}
        <ProviderSubagentFooter
          serverId={serverId}
          parentAgentId={target.parentAgentId}
          subagentId={target.subagentId}
          streamId={streamId}
          provider={provider}
          cwd={resolveSubagentCwd(descriptor, parent)}
          isPaneFocused={isPaneFocused}
          editingSession={editingSession}
        />
      </ComposerDock>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, minHeight: 0 },
  stream: { flex: 1, minHeight: 0 },
});

export const providerSubagentPanelRegistration = definePanel("provider_subagent", {
  component: ProviderSubagentPanel,
  useDescriptor: useProviderSubagentDescriptor,
});
