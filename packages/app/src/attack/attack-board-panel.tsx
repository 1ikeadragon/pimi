import { useCallback, useEffect, useMemo } from "react";
import { X } from "lucide-react-native";
import { Text, useWindowDimensions, View } from "react-native";
import { useTranslation } from "react-i18next";
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
import { AttackCompose, ATTACK_NARROW_WIDTH } from "./attack-compose";
import { AttackRunBar } from "./attack-run-bar";
import { AttackSubviewBar } from "./attack-subview-bar";
import { BrowserSubview } from "./subviews/browser-subview";
import { DesktopSubview } from "./subviews/desktop-subview";
import { TerminalSubview } from "./subviews/terminal-subview";
import { VisualizeSubview } from "./subviews/visualize-subview";
import type { AttackSubviewProps } from "./subviews/types";
import { AttackFindingsPanel } from "./attack-findings-panel";
import {
  selectSubview,
  type AttackSubview,
  useAttackFindings,
  useAttackStore,
  useAttackSync,
  useLatestAttackRun,
} from "./attack-store";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { isWeb } from "@/constants/platform";
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
  const subview = useAttackStore((state) => selectSubview(state, key, run?.id ?? null));
  const onSubview = useCallback(
    (view: AttackSubview) => {
      if (run) useAttackStore.getState().setSubview(key, run.id, view);
    },
    [key, run],
  );
  useReleaseFinishedRunBrowsers(serverId, workspaceId, run);

  const { width } = useWindowDimensions();
  const narrow = width < ATTACK_NARROW_WIDTH;
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  // The findings pane gives its width back to the board in a narrow window; the run bar's count
  // badge opens the same findings as an overlay.
  useEffect(() => {
    if (workspaceKey) {
      useWorkspaceLayoutStore.getState().setAttackFindingsPaneHidden(workspaceKey, narrow);
    }
    if (!narrow) useAttackStore.getState().setFindingsOverlay(key, false);
  }, [key, narrow, workspaceKey]);
  const overlayOpen = useAttackStore(
    (state) => narrow && state.findingsOverlayByWorkspace[key] === true,
  );
  const findingCount = useAttackFindings(serverId, run?.id ?? null).length;
  const toggleOverlay = useCallback(() => {
    const open = useAttackStore.getState().findingsOverlayByWorkspace[key] ?? false;
    useAttackStore.getState().setFindingsOverlay(key, !open);
  }, [key]);
  const closeOverlay = useCallback(() => {
    useAttackStore.getState().setFindingsOverlay(key, false);
  }, [key]);
  useEffect(() => {
    if (!isWeb || !overlayOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeOverlay();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [closeOverlay, overlayOpen]);
  const findingsBadge = useMemo(
    () => (narrow ? { count: findingCount, open: overlayOpen, onPress: toggleOverlay } : undefined),
    [findingCount, narrow, overlayOpen, toggleOverlay],
  );
  const active = isActive(run);
  const composing = run === null || (!active && composingAfter === run.id);
  const focus = run && rawFocus?.runId === run.id && !composing ? rawFocus : null;

  const workingCount = useMemo(
    () => agents.filter((item) => item.state === "working").length,
    [agents],
  );
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
      <AttackCompose
        serverId={serverId}
        workspaceId={workspaceId}
        formKey={run?.id ?? "first"}
        narrow={narrow}
      />
    );
  }
  if (!run) return null;
  let body;
  if (subview !== "overview") {
    const props: AttackSubviewProps = { serverId, workspaceId, run, agents, live: active };
    // Only the chosen subview is mounted, so a hidden one runs no timers or polling.
    if (subview === "terminal") body = <TerminalSubview {...props} />;
    else if (subview === "browser") body = <BrowserSubview {...props} />;
    else if (subview === "desktop") body = <DesktopSubview {...props} />;
    else body = <VisualizeSubview {...props} />;
  } else if (focus) {
    body = (
      <AttackAgentFocus
        agents={agents}
        focusedAgentId={focus.agentId}
        view={focus.view}
        onView={onView}
        onSelect={onFocus}
        onBack={onBack}
        escapeEnabled={!overlayOpen}
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
      <AttackRunBar
        run={run}
        serverId={serverId}
        onNewRun={onNewRun}
        findingsBadge={findingsBadge}
      />
      <AttackSubviewBar
        run={run}
        value={subview}
        onChange={onSubview}
        agentCount={agents.length}
        workingCount={workingCount}
      />
      {body}
      {overlayOpen ? (
        <>
          <PressHighlight
            onPress={closeOverlay}
            style={styles.backdrop}
            accessibilityLabel={t("attack.findings.close")}
            testID="attack-findings-backdrop"
          >
            <View />
          </PressHighlight>
          <View style={styles.drawer} testID="attack-findings-overlay">
            <View style={styles.drawerHeader}>
              <Text style={styles.drawerTitle}>{t("attack.panels.findings.label")}</Text>
              <Button
                size="sm"
                variant="ghost"
                leftIcon={X}
                onPress={closeOverlay}
                accessibilityLabel={t("attack.findings.close")}
                testID="attack-findings-close"
              />
            </View>
            <View style={styles.drawerBody}>
              <AttackFindingsPanel />
            </View>
          </View>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, minHeight: 0 },
  backdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 10,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  drawer: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    width: "92%",
    maxWidth: 420,
    zIndex: 11,
    borderLeftWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  drawerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
  },
  drawerBody: { flex: 1, minHeight: 0 },
  drawerTitle: { color: theme.colors.foreground, fontSize: theme.fontSize.base, fontWeight: "500" },
  starting: { flex: 1, alignItems: "center", justifyContent: "center" },
  startingText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
}));
