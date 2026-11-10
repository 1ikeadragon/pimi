import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  type RefObject,
} from "react";
import { router, usePathname } from "expo-router";
import { useIsFocused } from "expo-router/react-navigation";
import { useToast } from "@/contexts/toast-context";
import { getDesktopHost } from "@/desktop/host";
import { useStableEvent } from "@/hooks/use-stable-event";
import { resolveWorkspaceSelectionStatus } from "@/navigation/host-runtime-bootstrap";
import {
  navigateToWorkspace,
  useActiveWorkspaceSelection,
  useLastWorkspaceSelection,
  type ActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { useHasHydratedWorkspaces, useWorkspaceExists } from "@/stores/session-store-hooks";
import {
  useWorkspaceLayoutStore,
  useWorkspaceLayoutStoreHydrated,
} from "@/stores/workspace-layout-store";
import type { WorkbenchMode } from "@/stores/workspace-workbench";
import { buildOpenProjectRoute } from "@/utils/host-routes";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

let requestedModeForNextWorkspace: { mode: WorkbenchMode; workspaceKey?: string } | null = null;

export const PimiDraftEditorAction = createContext<RefObject<(() => void) | null> | null>(null);

export function usePimiDraftEditorAction(open: () => void) {
  const action = useContext(PimiDraftEditorAction);
  const focused = useIsFocused();
  const openDraft = useStableEvent(open);
  useLayoutEffect(() => {
    if (!action || !focused) return;
    action.current = openDraft;
    return () => {
      if (action.current === openDraft) action.current = null;
    };
  }, [action, focused, openDraft]);
}

export function navigateToNewWorkspaceInEditor(selection: ActiveWorkspaceSelection): void {
  const workspaceKey = buildWorkspaceTabPersistenceKey(selection);
  if (!workspaceKey) return;
  requestedModeForNextWorkspace = { mode: "editor", workspaceKey };
  getDesktopHost()?.dismissPimiWorkspace?.();
  navigateToWorkspace(selection);
}

/** Agent and IDE Mode exist only in the desktop window's split-pane layout. */
export function canSwitchWorkbench(layoutMode = useWorkspaceLayoutStore.getState().layoutMode) {
  return Boolean(getDesktopHost()?.showPimiWorkspace) && layoutMode === "split-panes";
}

export function usePimiWorkbenchMode(workspaceKey: string | null) {
  return useWorkspaceLayoutStore(
    (state) => (workspaceKey && state.workbenchByWorkspace[workspaceKey]?.mode) || "agent",
  );
}

/** Keep the selected mode when navigating between workspaces in the same window. */
export function useFollowWorkbenchMode(workspaceKey: string | null, enabled: boolean) {
  const hydrated = useWorkspaceLayoutStoreHydrated();
  const layoutMode = useWorkspaceLayoutStore((state) => state.layoutMode);
  const last = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!hydrated || !enabled || layoutMode !== "split-panes" || !workspaceKey) return;
    const requested = requestedModeForNextWorkspace;
    const requestedMode =
      requested && (!requested.workspaceKey || requested.workspaceKey === workspaceKey)
        ? requested.mode
        : null;
    if (!requestedMode && workspaceKey === last.current) return;
    const previous = last.current;
    last.current = workspaceKey;
    const state = useWorkspaceLayoutStore.getState();
    requestedModeForNextWorkspace = null;
    if (requestedMode) state.switchWorkbench(workspaceKey, requestedMode);
    else if (previous) {
      state.switchWorkbench(workspaceKey, state.workbenchByWorkspace[previous]?.mode ?? "agent");
    }
  }, [enabled, hydrated, layoutMode, workspaceKey]);
}

export function usePimiWorkbench() {
  const onDraftRoute = usePathname() === "/new";
  const draftEditorAction = useContext(PimiDraftEditorAction);
  const current = useActiveWorkspaceSelection();
  const last = useLastWorkspaceSelection();
  const lastServerId = last?.serverId ?? null;
  const lastWorkspaceStatus = resolveWorkspaceSelectionStatus({
    hasHydratedWorkspaces: useHasHydratedWorkspaces(lastServerId),
    workspaceExists: useWorkspaceExists(lastServerId, last?.workspaceId ?? null),
  });
  const layoutMode = useWorkspaceLayoutStore((state) => state.layoutMode);
  const selection = onDraftRoute
    ? null
    : (current ?? (lastWorkspaceStatus === "missing" ? null : last));
  const workspaceKey = selection && buildWorkspaceTabPersistenceKey(selection);
  const mode = usePimiWorkbenchMode(workspaceKey);
  const toast = useToast();

  const select = useCallback(
    (next: WorkbenchMode) => {
      if (onDraftRoute) {
        if (next === "editor") draftEditorAction?.current?.();
        return;
      }
      if (!selection) {
        requestedModeForNextWorkspace = { mode: next };
        getDesktopHost()?.dismissPimiWorkspace?.();
        router.navigate(buildOpenProjectRoute());
        toast.show("Open a project to use IDE Mode.");
        return;
      }
      const key = buildWorkspaceTabPersistenceKey(selection);
      if (!key) return;
      const result = useWorkspaceLayoutStore.getState().switchWorkbench(key, next);
      if (result === "unsaved") {
        toast.show("Save your changes before switching layouts.");
        return;
      }
      if (result === "unavailable") return;
      getDesktopHost()?.dismissPimiWorkspace?.();
      navigateToWorkspace(selection);
    },
    [draftEditorAction, onDraftRoute, selection, toast],
  );

  return {
    mode,
    select,
    activeWorkspaceKey: current ? workspaceKey : null,
    available: canSwitchWorkbench(layoutMode),
  };
}
