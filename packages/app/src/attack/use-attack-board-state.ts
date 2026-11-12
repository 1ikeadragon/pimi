import { useCallback, useEffect, useMemo } from "react";
import { useWindowDimensions } from "react-native";
import type { AttackRun } from "@pimi/protocol/attack/types";
import { isWeb } from "@/constants/platform";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { ATTACK_NARROW_WIDTH } from "./attack-compose";
import {
  useAttackFindings,
  useAttackStore,
  useLatestAttackRun,
  useViewedAttackRun,
} from "./attack-store";

/**
 * The board's run and its History state. `run` is the newest run, which owns the live board;
 * `historicRun` is an older run opened from History, shown as a summary, never as live tiles.
 */
export function useAttackHistoryView(serverId: string, workspaceId: string) {
  const run = useLatestAttackRun(serverId, workspaceId);
  const viewed = useViewedAttackRun(serverId, workspaceId);
  const key = `${serverId}:${workspaceId}`;
  const historyOpen = useAttackStore((state) => state.historyOpenByWorkspace[key] === true);
  const onHistory = useCallback(() => useAttackStore.getState().setHistoryOpen(key, true), [key]);
  const onCloseHistory = useCallback(
    () => useAttackStore.getState().setHistoryOpen(key, false),
    [key],
  );
  const onBackToLatest = useCallback(
    () => useAttackStore.getState().setViewedRun(key, null),
    [key],
  );
  const historicRun: AttackRun | null = run && viewed && viewed.id !== run.id ? viewed : null;
  return { run, viewed, historicRun, historyOpen, onHistory, onCloseHistory, onBackToLatest };
}

export function useFindingsOverlay(
  serverId: string,
  workspaceId: string,
  viewedRunId: string | null,
) {
  const key = `${serverId}:${workspaceId}`;
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
  const findingCount = useAttackFindings(serverId, viewedRunId).length;
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
  return { narrow, overlayOpen, toggleOverlay, closeOverlay, findingsBadge };
}

/** The focus and "New run" actions of the live board. */
export function useAttackFocusActions(
  key: string,
  run: AttackRun | null,
  rawFocus: { agentId: string } | null,
) {
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
  return { onFocus, onView, onBack, onNewRun };
}
