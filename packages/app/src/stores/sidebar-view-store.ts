import type { WorkspaceSort } from "@/projects/workspace-structure";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist, type StateStorage } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

export type SidebarGroupMode = "project" | "status";

const SIDEBAR_VIEW_STORAGE_KEY = "sidebar-view";
const LEGACY_SIDEBAR_GROUP_MODE_STORAGE_KEY = "sidebar-group-mode";
const SIDEBAR_VIEW_STORE_VERSION = 8;

/**
 * The key standing for "this workspace carries no labels at all".
 *
 * Label ids are non-empty daemon-generated strings, so nothing in `labels` can collide with the
 * empty string.
 */
export const SIDEBAR_UNLABELLED_LABEL_KEY = "";

/**
 * What the sidebar's Labels page currently says.
 *
 * The label ids pinned to, exactly as `hostFilters` holds server ids:
 * empty means "every label", non-empty includes workspaces carrying any selected label.
 */
export interface SidebarLabelFilter {
  labels: string[];
}

export function hasActiveSidebarLabelFilter(filter: SidebarLabelFilter): boolean {
  return filter.labels.length > 0;
}

/**
 * Include/exclude toggle over an allowlist, shared by the host and project filters.
 *
 * Both filters answer the same question — "is this one of the things I pinned the sidebar to" —
 * so they share the operation.
 */
function toggleFilterEntry(list: readonly string[], key: string): string[] {
  return list.includes(key) ? list.filter((entry) => entry !== key) : [...list, key];
}

interface SidebarViewStoreState {
  groupMode: SidebarGroupMode;
  workspaceSort: WorkspaceSort;
  showBackground: boolean;
  // Empty means "all hosts". A non-empty list pins the sidebar to those hosts.
  hostFilters: string[];
  /**
   * Empty means "all projects". A non-empty list is an allowlist over
   * `SidebarProjectEntry.viewKey` — the same key the project sections are built from.
   *
   * There is deliberately no `reconcileProjectFilters` counterpart to `reconcileHostFilters`.
   * The project list is narrowed by the host filter and is empty before any host connects, so
   * reconciling against it would silently destroy the filter on every cold start and every
   * host-filter change. Stale keys are resolved away at read time instead — see
   * `resolveActiveProjectFilters`.
   */
  projectFilters: string[];
  labelFilter: SidebarLabelFilter;
  toggleBackground: () => void;
  setGroupMode: (mode: SidebarGroupMode) => void;
  setWorkspaceSort: (sort: WorkspaceSort) => void;
  toggleHostFilter: (serverId: string) => void;
  clearHostFilters: () => void;
  toggleProjectFilter: (viewKey: string) => void;
  clearProjectFilters: () => void;
  toggleLabelFilter: (labelId: string) => void;
  clearLabelFilter: () => void;
  reconcileLabelFilter: (labelIds: readonly string[]) => void;
  reconcileHostFilters: (serverIds: readonly string[]) => void;
}

interface SidebarViewPersistedState {
  groupMode: SidebarGroupMode;
  workspaceSort: WorkspaceSort;
  showBackground: boolean;
  hostFilters: string[];
  projectFilters: string[];
  labelFilter: SidebarLabelFilter;
}

const PersistedSidebarGroupModeSchema = z.enum(["project", "status", "label"]);
const SidebarLabelFilterSchema = z.object({
  labels: z.array(z.string()),
});
const SidebarViewPersistedStateSchema = z.strictObject({
  workspaceSort: z.enum(["manual", "created", "lastPrompt"]).optional(),
  showBackground: z.boolean().optional(),
  groupMode: PersistedSidebarGroupModeSchema.optional(),
  hostFilters: z.array(z.string()).optional(),
  projectFilters: z.array(z.string()).optional(),
  groupModeByServerId: z.record(z.string(), PersistedSidebarGroupModeSchema).optional(),
  labelFilter: SidebarLabelFilterSchema.optional(),
});

type SidebarViewStorageState = z.infer<typeof SidebarViewPersistedStateSchema>;

function readLegacyGroupMode(persistedState: SidebarViewStorageState): SidebarGroupMode | null {
  const groupModeByServerId = persistedState.groupModeByServerId;
  if (!groupModeByServerId) {
    return null;
  }

  const modes = Object.values(groupModeByServerId);
  if (modes.length === 0) return null;
  return modes.includes("status") ? "status" : "project";
}

export function migrateSidebarViewState(persistedState: unknown): SidebarViewPersistedState {
  const result = SidebarViewPersistedStateSchema.safeParse(persistedState);
  if (!result.success) {
    return {
      showBackground: false,
      groupMode: "project",
      workspaceSort: "created",
      hostFilters: [],
      projectFilters: [],
      labelFilter: emptyLabelFilter(),
    };
  }
  const state = result.data;

  const legacyGroupMode = readLegacyGroupMode(state);
  if (legacyGroupMode) {
    return {
      showBackground: false,
      groupMode: legacyGroupMode,
      workspaceSort: "created",
      hostFilters: [],
      projectFilters: [],
      labelFilter: emptyLabelFilter(),
    };
  }

  return {
    showBackground: state.showBackground ?? false,
    groupMode: state.groupMode === "status" ? "status" : "project",
    workspaceSort: state.workspaceSort ?? "created",
    hostFilters: state.hostFilters ?? [],
    projectFilters: state.projectFilters ?? [],
    labelFilter: state.labelFilter
      ? normalizeSidebarLabelFilter(state.labelFilter)
      : emptyLabelFilter(),
  };
}

/**
 * Dedupes a persisted filter. Values written before labels had ids are names; they match no id
 * and `reconcileLabelFilter` drops them once the catalogs load.
 */
function normalizeSidebarLabelFilter(filter: SidebarLabelFilter): SidebarLabelFilter {
  return { labels: [...new Set(filter.labels)] };
}

export function createSidebarViewStorage(
  backingStorage: StateStorage = AsyncStorage,
): StateStorage {
  return {
    getItem: async (name) => {
      const value = await backingStorage.getItem(name);
      if (value !== null || name !== SIDEBAR_VIEW_STORAGE_KEY) {
        return value;
      }
      return backingStorage.getItem(LEGACY_SIDEBAR_GROUP_MODE_STORAGE_KEY);
    },
    setItem: (name, value) => backingStorage.setItem(name, value),
    removeItem: (name) => backingStorage.removeItem(name),
  };
}

export const useSidebarViewStore = create<SidebarViewStoreState>()(
  persist(
    (set) => ({
      showBackground: false,
      groupMode: "project",
      workspaceSort: "created",
      hostFilters: [],
      projectFilters: [],
      labelFilter: emptyLabelFilter(),
      toggleBackground: () => set((state) => ({ showBackground: !state.showBackground })),
      setGroupMode: (mode) => set({ groupMode: mode }),
      setWorkspaceSort: (workspaceSort) => set({ workspaceSort }),
      toggleHostFilter: (serverId) =>
        set((state) => ({ hostFilters: toggleFilterEntry(state.hostFilters, serverId) })),
      clearHostFilters: () => set({ hostFilters: [] }),
      toggleProjectFilter: (viewKey) =>
        set((state) => ({ projectFilters: toggleFilterEntry(state.projectFilters, viewKey) })),
      clearProjectFilters: () => set({ projectFilters: [] }),
      toggleLabelFilter: (labelId) =>
        set((state) => ({
          labelFilter: {
            ...state.labelFilter,
            labels: toggleFilterEntry(state.labelFilter.labels, labelId),
          },
        })),
      clearLabelFilter: () => set({ labelFilter: emptyLabelFilter() }),
      reconcileLabelFilter: (labelIds) =>
        set((state) => {
          const available = new Set(labelIds);
          const next = state.labelFilter.labels.filter(
            (label) => label === SIDEBAR_UNLABELLED_LABEL_KEY || available.has(label),
          );
          if (next.length === state.labelFilter.labels.length) return state;
          return { labelFilter: { labels: next } };
        }),
      reconcileHostFilters: (serverIds) =>
        set((state) => {
          if (state.hostFilters.length === 0) {
            return state;
          }
          const allowed = new Set(serverIds);
          const next = state.hostFilters.filter((id) => allowed.has(id));
          if (next.length === state.hostFilters.length) {
            return state;
          }
          return { hostFilters: next };
        }),
    }),
    {
      name: SIDEBAR_VIEW_STORAGE_KEY,
      version: SIDEBAR_VIEW_STORE_VERSION,
      storage: createValidatedPersistStorage(
        createSidebarViewStorage(),
        SidebarViewPersistedStateSchema,
      ),
      partialize: (state) => ({
        showBackground: state.showBackground ?? false,
        groupMode: state.groupMode,
        workspaceSort: state.workspaceSort,
        hostFilters: state.hostFilters,
        projectFilters: state.projectFilters,
        labelFilter: state.labelFilter,
      }),
      migrate: migrateSidebarViewState,
    },
  ),
);

function emptyLabelFilter(): SidebarLabelFilter {
  return { labels: [] };
}
