import { useCallback, useMemo } from "react";
import { i18n } from "@/i18n/i18next";
import { useTranslation } from "@/i18n/use-translation";
import { useSessionStore, type AgentFileExplorerState } from "@/stores/session-store";
import { usePanelStore } from "@/stores/panel-store";
import { revealExplorerDirectory } from "@/file-explorer/tree";
import {
  loadExplorerDirectory,
  type DirectoryListingResult,
  invalidateExplorerDirectoryListings,
} from "@/file-explorer/directory-listings";
import { parentExplorerPath } from "@/utils/explorer-paths";

function createExplorerState(): AgentFileExplorerState {
  return {
    listingGeneration: 0,
    directories: new Map(),
    isLoading: false,
    lastError: null,
    pendingRequest: null,
    currentPath: ".",
    history: ["."],
    lastVisitedPath: ".",
    selectedEntryPath: null,
  };
}

export interface FileExplorerWorkspaceScope {
  workspaceId?: string | null;
  workspaceRoot?: string | null;
}

function normalizeWorkspaceValue(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function buildWorkspaceExplorerStateKey(scope: FileExplorerWorkspaceScope): string | null {
  const normalizedWorkspaceId = normalizeWorkspaceValue(scope.workspaceId);
  if (normalizedWorkspaceId) {
    return `workspace:${normalizedWorkspaceId}`;
  }
  const normalizedWorkspaceRoot = normalizeWorkspaceValue(scope.workspaceRoot);
  if (!normalizedWorkspaceRoot) {
    return null;
  }
  return `root:${normalizedWorkspaceRoot}`;
}

/**
 * Expands Files down to a directory and selects it, for any workspace: the explorer state lives in
 * the session store, so the workspace need not be mounted yet.
 */
export async function revealWorkspaceDirectory(
  input: { serverId: string; directoryPath: string } & FileExplorerWorkspaceScope,
): Promise<void> {
  const stateKey = buildWorkspaceExplorerStateKey(input);
  const root = normalizeWorkspaceValue(input.workspaceRoot);
  if (!stateKey || !root) return;
  const updateState = (
    updater: (prev: AgentFileExplorerState) => AgentFileExplorerState,
  ): AgentFileExplorerState | null => {
    let updated: AgentFileExplorerState | null = null;
    useSessionStore.getState().setFileExplorer(input.serverId, (prev) => {
      const next = new Map(prev);
      updated = updater(next.get(stateKey) ?? createExplorerState());
      next.set(stateKey, updated);
      return next;
    });
    return updated;
  };
  const panel = usePanelStore.getState();
  await revealExplorerDirectory({
    directoryPath: input.directoryPath,
    requestDirectoryListing: (path) =>
      loadExplorerDirectory({
        path,
        updateState,
        fallbackError: i18n.t("workspace.fileExplorer.errors.failedToListDirectory"),
        listDirectory: async () => {
          const client = useSessionStore.getState().sessions[input.serverId]?.client;
          if (!client) throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
          return client.listDirectory(root, path);
        },
      }),
    showHiddenFiles: () => {
      if (!panel.explorerShowHiddenFiles) panel.toggleExplorerShowHiddenFiles();
    },
    expandPaths: (paths) =>
      usePanelStore
        .getState()
        .setExpandedPathsForWorkspace(stateKey, (current) =>
          Array.from(new Set([...current, ...paths])),
        ),
  });
  if (input.directoryPath !== ".") {
    updateState((state) => ({ ...state, selectedEntryPath: input.directoryPath }));
  }
}

export function useFileExplorerActions(params: { serverId: string } & FileExplorerWorkspaceScope) {
  const { t } = useTranslation();
  const { serverId, workspaceId, workspaceRoot } = params;
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const setFileExplorer = useSessionStore((state) => state.setFileExplorer);
  const normalizedWorkspaceRoot = useMemo(
    () => normalizeWorkspaceValue(workspaceRoot),
    [workspaceRoot],
  );
  const workspaceStateKey = useMemo(
    () =>
      buildWorkspaceExplorerStateKey({
        workspaceId,
        workspaceRoot: normalizedWorkspaceRoot,
      }),
    [workspaceId, normalizedWorkspaceRoot],
  );

  const updateExplorerState = useCallback(
    (
      updater: (prev: AgentFileExplorerState) => AgentFileExplorerState,
    ): AgentFileExplorerState | null => {
      if (!workspaceStateKey) {
        return null;
      }
      let updated: AgentFileExplorerState | null = null;
      setFileExplorer(serverId, (prev) => {
        const next = new Map(prev);
        const current = next.get(workspaceStateKey) ?? createExplorerState();
        updated = updater(current);
        next.set(workspaceStateKey, updated);
        return next;
      });
      return updated;
    },
    [serverId, setFileExplorer, workspaceStateKey],
  );

  const requestDirectoryListing = useCallback(
    async (
      path: string,
      options?: { recordHistory?: boolean; setCurrentPath?: boolean },
    ): Promise<DirectoryListingResult> => {
      if (!workspaceStateKey) {
        return null;
      }
      const normalizedPath = path && path.length > 0 ? path : ".";
      return loadExplorerDirectory({
        path: normalizedPath,
        options,
        updateState: updateExplorerState,
        fallbackError: t("workspace.fileExplorer.errors.failedToListDirectory"),
        listDirectory: async () => {
          if (!normalizedWorkspaceRoot)
            throw new Error(t("workspace.fileExplorer.states.unavailable"));
          if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
          return client.listDirectory(normalizedWorkspaceRoot, normalizedPath);
        },
      });
    },
    [client, normalizedWorkspaceRoot, t, updateExplorerState, workspaceStateKey],
  );

  const revealDirectory = useCallback(
    (directoryPath: string) =>
      revealWorkspaceDirectory({ serverId, workspaceId, workspaceRoot, directoryPath }),
    [serverId, workspaceId, workspaceRoot],
  );

  const requestFileDownloadToken = useCallback(
    async (path: string) => {
      if (!normalizedWorkspaceRoot) {
        throw new Error(t("workspace.fileExplorer.states.unavailable"));
      }
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const payload = await client.requestDownloadToken(normalizedWorkspaceRoot, path);
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload;
    },
    [client, normalizedWorkspaceRoot, t],
  );

  const requestFileBytes = useCallback(
    async (path: string, maxBytes: number) => {
      if (!normalizedWorkspaceRoot) {
        throw new Error(t("workspace.fileExplorer.states.unavailable"));
      }
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      // No request timeout: a large file over a slow relay legitimately takes longer than the
      // 60 s default, and a dead connection still rejects on disconnect.
      return client.readFile(normalizedWorkspaceRoot, path, undefined, maxBytes, 0);
    },
    [client, normalizedWorkspaceRoot, t],
  );

  const createEntry = useCallback(
    async (input: { parentPath: string; name: string; kind: "file" | "directory" }) => {
      if (!client || !normalizedWorkspaceRoot) {
        return null;
      }
      const payload = await client.createFileEntry({
        cwd: normalizedWorkspaceRoot,
        ...input,
      });
      if (payload.success) {
        await requestDirectoryListing(input.parentPath, {
          recordHistory: false,
          setCurrentPath: false,
        });
      }
      return payload;
    },
    [client, normalizedWorkspaceRoot, requestDirectoryListing],
  );

  const renameEntry = useCallback(
    async (input: { path: string; name: string }) => {
      if (!client || !normalizedWorkspaceRoot) {
        return null;
      }
      const payload = await client.renameFileEntry({
        cwd: normalizedWorkspaceRoot,
        ...input,
      });
      if (payload.success) {
        await requestDirectoryListing(parentExplorerPath(input.path), {
          recordHistory: false,
          setCurrentPath: false,
        });
      }
      return payload;
    },
    [client, normalizedWorkspaceRoot, requestDirectoryListing],
  );

  const duplicateEntry = useCallback(
    async (path: string) => {
      if (!client || !normalizedWorkspaceRoot) {
        return null;
      }
      const payload = await client.duplicateFileEntry({ cwd: normalizedWorkspaceRoot, path });
      if (payload.success) {
        await requestDirectoryListing(parentExplorerPath(path), {
          recordHistory: false,
          setCurrentPath: false,
        });
      }
      return payload;
    },
    [client, normalizedWorkspaceRoot, requestDirectoryListing],
  );

  const deleteEntry = useCallback(
    async (path: string) => {
      if (!client || !normalizedWorkspaceRoot) {
        return null;
      }
      const payload = await client.deleteFileEntry({ cwd: normalizedWorkspaceRoot, path });
      if (payload.success) {
        await requestDirectoryListing(parentExplorerPath(path), {
          recordHistory: false,
          setCurrentPath: false,
        });
      }
      return payload;
    },
    [client, normalizedWorkspaceRoot, requestDirectoryListing],
  );

  const selectExplorerEntry = useCallback(
    (path: string | null) => {
      updateExplorerState((state) => ({
        ...state,
        selectedEntryPath: path,
      }));
    },
    [updateExplorerState],
  );

  const invalidateDirectoryListings = useCallback(
    (retainedPaths: readonly string[]) =>
      invalidateExplorerDirectoryListings(updateExplorerState, retainedPaths),
    [updateExplorerState],
  );

  return {
    workspaceStateKey,
    revealDirectory,
    requestDirectoryListing,
    invalidateDirectoryListings,
    requestFileDownloadToken,
    requestFileBytes,
    createEntry,
    renameEntry,
    duplicateEntry,
    deleteEntry,
    selectExplorerEntry,
  };
}
