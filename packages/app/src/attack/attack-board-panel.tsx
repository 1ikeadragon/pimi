import { useCallback, useEffect } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Swords } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AttackRun } from "@pimi/protocol/attack/types";
import { getDesktopHost } from "@/desktop/host";
import { useBrowserStore } from "@/desktop/browser/store";
import { removeResidentBrowserWebview } from "@/desktop/browser/resident-webviews";
import { usePaneContext } from "@/panels/pane-context";
import { collectAllTabs } from "@/stores/workspace-layout-actions";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { AttackAgentFocus } from "./attack-agent-focus";
import { AttackAgentGrid } from "./attack-agent-grid";
import { LaunchForm } from "./attack-launch-form";
import { AttackRunBar } from "./attack-run-bar";
import { useAttackStore, useAttackSync, useLatestAttackRun } from "./attack-store";
import { useAttackRunAgents } from "./use-attack-run-agents";

function isActive(run: AttackRun | null): boolean {
  return run !== null && (run.status === "running" || run.status === "paused");
}

/**
 * Browser tabs an Attack agent opened belong to its run. Once a run is over, or a newer run took
 * over, its tabs are closed and their webviews destroyed, so a board never shows or keeps an
 * earlier run's tabs.
 */
function useReleaseFinishedRunBrowsers(
  serverId: string,
  workspaceId: string,
  run: AttackRun | null,
) {
  const browsersById = useBrowserStore((state) => state.browsersById);
  const runs = useAttackStore((state) => state.byServer[serverId]?.runs);
  const activeRunId = run && isActive(run) ? run.id : null;
  useEffect(() => {
    const stale = Object.values(browsersById).filter(
      (record) =>
        record.owner !== null &&
        record.owner.runId !== activeRunId &&
        // Only this workspace's runs; another workspace's live run keeps its tabs.
        runs?.[record.owner.runId]?.workspaceId === workspaceId,
    );
    if (stale.length === 0) return;
    const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
    const layoutStore = useWorkspaceLayoutStore.getState();
    const layout = workspaceKey ? layoutStore.layoutByWorkspace[workspaceKey] : null;
    const tabs = layout ? collectAllTabs(layout.root) : [];
    for (const record of stale) {
      const tab = tabs.find(
        (candidate) =>
          candidate.target.kind === "browser" && candidate.target.browserId === record.browserId,
      );
      if (tab && workspaceKey) layoutStore.closeTab(workspaceKey, tab.tabId);
      removeResidentBrowserWebview(record.browserId);
      void getDesktopHost()?.browser?.unregisterWorkspaceBrowser?.(record.browserId);
      useBrowserStore.getState().removeBrowser(record.browserId);
    }
  }, [activeRunId, browsersById, runs, serverId, workspaceId]);
}

export function AttackBoardPanel() {
  const { t } = useTranslation();
  const { serverId, workspaceId } = usePaneContext();
  useAttackSync(serverId, workspaceId);
  const run = useLatestAttackRun(serverId, workspaceId);
  const key = `${serverId}:${workspaceId}`;
  const composingAfter = useAttackStore((state) => state.composingByWorkspace[key] ?? null);
  const rawFocus = useAttackStore((state) => state.focusByWorkspace[key] ?? null);
  const agents = useAttackRunAgents(serverId, run);
  useReleaseFinishedRunBrowsers(serverId, workspaceId, run);

  const active = isActive(run);
  const composing = run === null || (!active && composingAfter === run.id);
  const focus = run && rawFocus?.runId === run.id && !composing ? rawFocus : null;

  const onFocus = useCallback(
    (agentId: string) => {
      if (run) useAttackStore.getState().setFocus(key, run.id, { agentId, view: "chat" });
    },
    [key, run],
  );
  const onView = useCallback(
    (view: "chat" | "browser") => {
      if (run && rawFocus) {
        useAttackStore.getState().setFocus(key, run.id, { agentId: rawFocus.agentId, view });
      }
    },
    [key, rawFocus, run],
  );
  const onBack = useCallback(() => {
    if (run) useAttackStore.getState().setFocus(key, run.id, null);
  }, [key, run]);
  const onNewRun = useCallback(() => {
    if (!run) return;
    useAttackStore.getState().setFocus(key, run.id, null);
    useAttackStore.getState().setComposing(key, run.id);
  }, [key, run]);

  if (composing) {
    return (
      <ScrollView contentContainerStyle={styles.idle} testID="attack-board-idle">
        <View style={styles.hero}>
          <Swords size={18} color="currentColor" />
          <Text style={styles.heroTitle}>{t("attack.board.title")}</Text>
        </View>
        <LaunchForm key={run?.id ?? "first"} serverId={serverId} workspaceId={workspaceId} />
      </ScrollView>
    );
  }
  if (!run) return null;
  let body;
  if (focus) {
    body = (
      <AttackAgentFocus
        agents={agents}
        focusedAgentId={focus.agentId}
        view={focus.view}
        onView={onView}
        onSelect={onFocus}
        onBack={onBack}
      />
    );
  } else if (agents.length > 0) {
    body = (
      <AttackAgentGrid
        agents={agents}
        serverId={serverId}
        workspaceId={workspaceId}
        live={active}
        onFocus={onFocus}
      />
    );
  } else {
    body = (
      <View style={styles.starting}>
        <Text style={styles.startingText}>{t("attack.board.starting")}</Text>
      </View>
    );
  }
  return (
    <View style={styles.root} testID="attack-board">
      <AttackRunBar run={run} serverId={serverId} onNewRun={onNewRun} />
      {body}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, minHeight: 0 },
  idle: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
    gap: theme.spacing[4],
  },
  hero: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  heroTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: "500",
  },
  starting: { flex: 1, alignItems: "center", justifyContent: "center" },
  startingText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
}));
