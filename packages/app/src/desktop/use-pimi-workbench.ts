import { createContext, useCallback, useContext, useLayoutEffect, type RefObject } from "react";
import { router, usePathname } from "expo-router";
import { useIsFocused } from "expo-router/react-navigation";
import { useToast } from "@/contexts/toast-context";
import { i18n } from "@/i18n/i18next";
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

/** Makes IDE Mode the window's mode, then opens a chat that was just created for it. */
export function navigateToNewWorkspaceInEditor(selection: ActiveWorkspaceSelection): void {
  useWorkspaceLayoutStore.getState().setWindowWorkbenchMode("editor");
  getDesktopHost()?.dismissPimiWorkspace?.();
  navigateToWorkspace(selection);
}

/** Agent, IDE and Attack Mode exist only in the desktop window's split-pane layout. */
export function canSwitchWorkbench(layoutMode = useWorkspaceLayoutStore.getState().layoutMode) {
  return Boolean(getDesktopHost()?.showPimiWorkspace) && layoutMode === "split-panes";
}

/** The mode this chat's layout is in, which is what its panes render. */
export function usePimiWorkbenchMode(workspaceKey: string | null) {
  return useWorkspaceLayoutStore(
    (state) => (workspaceKey && state.workbenchByWorkspace[workspaceKey]?.mode) || "agent",
  );
}

/**
 * One mode per window: a chat that is shown while its layout is in another mode is brought to the
 * window's mode. Only the chat being shown changes, so retained chats switch when they are shown
 * rather than all at once. A chat that cannot switch (unsaved edits) keeps its own layout, the
 * window mode stays, and the toggle reads the chat's layout.
 */
export function useFollowWorkbenchMode(workspaceKey: string | null, enabled: boolean) {
  const hydrated = useWorkspaceLayoutStoreHydrated();
  const layoutMode = useWorkspaceLayoutStore((state) => state.layoutMode);
  const toast = useToast();
  // The toast API's identity must not re-run the effect, or an unsaved chat would toast every render.
  const showUnsaved = useStableEvent(() => toast.show(i18n.t("ideMode.unsavedLayout")));
  useLayoutEffect(() => {
    if (!hydrated || !enabled || layoutMode !== "split-panes" || !workspaceKey) return;
    const result = useWorkspaceLayoutStore.getState().followWindowWorkbench(workspaceKey);
    if (result === "unsaved") showUnsaved();
  }, [enabled, hydrated, layoutMode, showUnsaved, workspaceKey]);
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
  const chatMode = usePimiWorkbenchMode(workspaceKey);
  const windowMode = useWorkspaceLayoutStore((state) => state.windowWorkbenchMode) ?? "agent";
  // What is on screen wins: a chat that could not follow the window (unsaved edits) shows its own
  // layout. With no chat on screen (/new, open project) the toggle shows the window's mode.
  const mode = workspaceKey ? chatMode : windowMode;
  const toast = useToast();

  const select = useCallback(
    (next: WorkbenchMode) => {
      const store = useWorkspaceLayoutStore.getState();
      if (onDraftRoute) {
        // Attack Mode needs a project, which a draft does not have yet.
        if (next === "attack") return;
        store.setWindowWorkbenchMode(next);
        if (next === "editor") draftEditorAction?.current?.();
        return;
      }
      if (!selection) {
        store.setWindowWorkbenchMode(next);
        getDesktopHost()?.dismissPimiWorkspace?.();
        router.navigate(buildOpenProjectRoute());
        toast.show(
          next === "attack" ? i18n.t("attack.mode.openProject") : i18n.t("ideMode.openProject"),
        );
        return;
      }
      const key = buildWorkspaceTabPersistenceKey(selection);
      if (!key) return;
      const result = store.switchWorkbench(key, next);
      if (result === "unsaved") {
        toast.show(i18n.t("ideMode.unsavedLayout"));
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
