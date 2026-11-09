import { useCallback, useLayoutEffect, useRef } from "react";
import { router } from "expo-router";
import { useToast } from "@/contexts/toast-context";
import { getDesktopHost } from "@/desktop/host";
import {
  navigateToWorkspace,
  useActiveWorkspaceSelection,
  useLastWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import {
  useWorkspaceLayoutStore,
  useWorkspaceLayoutStoreHydrated,
} from "@/stores/workspace-layout-store";
import type { WorkbenchMode } from "@/stores/workspace-workbench";
import { buildOpenProjectRoute } from "@/utils/host-routes";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

let requestedModeForNextWorkspace: WorkbenchMode | null = null;

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
    if (
      !hydrated ||
      !enabled ||
      layoutMode !== "split-panes" ||
      !workspaceKey ||
      workspaceKey === last.current
    )
      return;
    const previous = last.current;
    last.current = workspaceKey;
    const state = useWorkspaceLayoutStore.getState();
    const requested = requestedModeForNextWorkspace;
    requestedModeForNextWorkspace = null;
    if (requested) state.switchWorkbench(workspaceKey, requested);
    else if (previous) {
      state.switchWorkbench(workspaceKey, state.workbenchByWorkspace[previous]?.mode ?? "agent");
    }
  }, [enabled, hydrated, layoutMode, workspaceKey]);
}

export function usePimiWorkbench() {
  const current = useActiveWorkspaceSelection();
  const last = useLastWorkspaceSelection();
  const layoutMode = useWorkspaceLayoutStore((state) => state.layoutMode);
  const selection = current ?? last;
  const workspaceKey = selection && buildWorkspaceTabPersistenceKey(selection);
  const mode = usePimiWorkbenchMode(workspaceKey);
  const toast = useToast();

  const select = useCallback(
    (next: WorkbenchMode) => {
      if (!selection) {
        requestedModeForNextWorkspace = next;
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
    [selection, toast],
  );

  return {
    mode,
    select,
    activeWorkspaceKey: current ? workspaceKey : null,
    available: Boolean(getDesktopHost()?.showPimiWorkspace) && layoutMode === "split-panes",
  };
}
