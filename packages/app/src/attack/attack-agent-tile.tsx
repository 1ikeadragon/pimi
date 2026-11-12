import { memo, useCallback, useMemo } from "react";
import { Image, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Globe } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { AgentStreamView } from "@/agent-stream/view";
import { resolveWorkingStatus } from "@/agent-stream/working-status";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { withUnistyles } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useAgentTileStream } from "@/hooks/use-agent-tile-stream";
import { useSessionStore } from "@/stores/session-store";
import type { PendingPermission } from "@/types/shared";
import type { AttackTileState, AttackRunAgent } from "./use-attack-run-agents";
import { useBrowserThumbnail } from "./use-browser-thumbnail";

const TileSpinner = withUnistyles(LoadingSpinner, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
const EMPTY_PERMISSIONS = new Map<string, PendingPermission>();

export const AttackAgentTile = memo(function AttackAgentTile({
  row,
  serverId,
  workspaceId,
  live,
  onFocus,
}: {
  row: AttackRunAgent;
  serverId: string;
  workspaceId: string;
  /** False while the window is hidden or a focus view is open: no refreshing stills. */
  live: boolean;
  onFocus: (agentId: string) => void;
}) {
  const { t } = useTranslation();
  const { agent, state, role } = row;
  const id = agent.id;
  const { items, ready, turnPresentation, timelineStatus, anchor } = useAgentTileStream(
    serverId,
    id,
  );
  const waiting = state === "waiting";
  const browser = waiting ? null : (row.browsers.at(-1) ?? null);
  const thumbnail = useBrowserThumbnail(
    browser?.browserId ?? null,
    workspaceId,
    live && state === "working",
  );
  const permissions = useSessionStore((s) =>
    waiting ? (s.sessions[serverId]?.pendingPermissions ?? EMPTY_PERMISSIONS) : EMPTY_PERMISSIONS,
  );
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
  const actionLine = useMemo(() => {
    if (state === "done" || state === "idle") return t(`attack.tile.state.${state}`);
    if (state === "failed") return agent.lastError ?? t("attack.tile.state.failed");
    return resolveWorkingStatus({
      isCancelling: turnPresentation.isCancelling,
      hasPendingPermission: waiting,
      agentStatus: agent.status,
      providerLabel: agent.provider,
      turnStartedAt: turnPresentation.startedAt,
      latest: items.at(-1),
      activeTurnId: turnPresentation.turnId,
      cwd: agent.cwd,
      t,
    }).label;
  }, [
    agent.cwd,
    agent.lastError,
    agent.provider,
    agent.status,
    items,
    state,
    t,
    turnPresentation.isCancelling,
    turnPresentation.startedAt,
    turnPresentation.turnId,
    waiting,
  ]);
  const stillSource = useMemo(() => (thumbnail ? { uri: thumbnail } : undefined), [thumbnail]);
  const press = useCallback(() => onFocus(id), [id, onFocus]);
  return (
    <View
      style={[styles.tile, state === "done" && styles.tileDone, waiting && styles.tileWaiting]}
      testID={`attack-tile-${id}`}
    >
      <PressHighlight
        onPress={press}
        style={styles.header}
        accessibilityRole="button"
        accessibilityLabel={t("attack.tile.focus", { role })}
        testID={`attack-tile-focus-${id}`}
      >
        <View style={[styles.dot, dotStyles[state]]} />
        <View style={styles.titles}>
          <Text style={styles.role} numberOfLines={1}>
            {role}
          </Text>
          <Text style={styles.action} numberOfLines={1}>
            {actionLine}
          </Text>
        </View>
        {row.browsers.length > 0 ? <Globe size={13} color="currentColor" /> : null}
      </PressHighlight>
      {browser && !waiting ? (
        <PressHighlight onPress={press} style={styles.preview} testID={`attack-tile-browser-${id}`}>
          {thumbnail ? (
            <Image
              source={stillSource}
              style={styles.still}
              resizeMode="cover"
              accessibilityIgnoresInvertColors
            />
          ) : (
            <View style={styles.stillPlaceholder}>
              <TileSpinner />
            </View>
          )}
        </PressHighlight>
      ) : (
        <View style={styles.transcript}>
          <AgentStreamView
            agentId={id}
            serverId={serverId}
            context={context}
            streamItems={items}
            pendingPermissions={permissions}
            turnPresentation={turnPresentation}
            readOnly={!waiting}
            isAuthoritativeHistoryReady={ready}
            routeBottomAnchorRequest={anchor}
          />
          {!ready && timelineStatus !== "ready" ? (
            <View style={styles.loading} pointerEvents="none">
              <TileSpinner />
            </View>
          ) : null}
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
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
  tileDone: { opacity: 0.6 },
  tileWaiting: { borderColor: theme.colors.palette.amber[500] },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  titles: { flex: 1, minWidth: 0 },
  role: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "500",
  },
  action: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  // A page assumes a white canvas; the still keeps its transparent background.
  preview: { flex: 1, minHeight: 0, backgroundColor: "#ffffff" },
  still: { width: "100%", height: "100%", borderWidth: 1, borderColor: theme.colors.border },
  stillPlaceholder: { flex: 1, alignItems: "center", justifyContent: "center" },
  transcript: { flex: 1, minHeight: 0 },
  loading: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
}));

const dotStyles = StyleSheet.create((theme) => ({
  working: { backgroundColor: theme.colors.palette.green[500] },
  waiting: { backgroundColor: theme.colors.palette.amber[500] },
  idle: { backgroundColor: theme.colors.foregroundMuted },
  failed: { backgroundColor: theme.colors.palette.red[500] },
  done: { backgroundColor: theme.colors.border },
})) satisfies Record<AttackTileState, unknown>;
