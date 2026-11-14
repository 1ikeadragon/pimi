import { useTranslation } from "@/i18n/use-translation";
import React, { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import equal from "fast-deep-equal";
import { useStoreWithEqualityFn } from "zustand/traditional";
import {
  useSidebarWorkspacesList,
  type SidebarProjectEntry,
  type SidebarWorkspaceEntry,
  type SidebarWorkspacesListResult,
} from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarWorkspaceEntries } from "@/hooks/use-sidebar-workspace-entries";
import { usePinnedSidebarKeys, type PinnedSidebarGroups } from "@/hooks/use-sidebar-pins";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import {
  hasActiveSidebarLabelFilter,
  useSidebarViewStore,
  type SidebarGroupMode,
} from "@/stores/sidebar-view-store";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import type { SidebarShortcutModel } from "@/utils/sidebar-shortcuts";
import { buildSidebarProjection } from "./sidebar-projection";
import type { SidebarProjectIconTarget } from "@/utils/sidebar-project-row-model";
import { filterWorkspacesByLabels, type SidebarWorkspaceGroup } from "./sidebar-labels";
import { filterWorkspacesByProjects, resolveActiveProjectFilters } from "./sidebar-project-filter";
import {
  hasAuthoritativeLabelCatalog,
  labelTargetKey,
  useLabelProjection,
  useLabelStore,
} from "@/labels/store";
import { selectWorkspaceRootChats } from "@/chats/primary-chat";
import { useSessionStore } from "@/stores/session-store";

interface SidebarModel extends SidebarWorkspacesListResult {
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  /**
   * Every project the sidebar could show, before any filter narrows it.
   *
   * `projects` is the FILTERED list. A surface that offers a filter picker must read this one, or
   * narrowing the filter deletes the rows that would undo it.
   */
  allProjects: SidebarProjectEntry[];
  /** The project filter as it is actually being applied — see `resolveActiveProjectFilters`. */
  resolvedProjectFilters: readonly string[];
  hasProjectsBeforeFilter: boolean;
  groupMode: SidebarGroupMode;
  workspaceGroups: SidebarWorkspaceGroup[];
  projectIconTargets: SidebarProjectIconTarget[];
  pinnedGroups: PinnedSidebarGroups;
  collapsedProjectKeys: ReadonlySet<string>;
  toggleProjectCollapsed: (projectViewKey: string) => void;
  shortcutModel: SidebarShortcutModel;
}

const NO_ROOT_CHATS: ReadonlyMap<string, string[]> = new Map();

const SidebarModelContext = createContext<SidebarModel | null>(null);

export function SidebarModelProvider({
  active,
  keyboardNavigationActive = false,
  children,
}: {
  active?: boolean;
  keyboardNavigationActive?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const modelActive = active !== false || keyboardNavigationActive;
  const list = useSidebarWorkspacesList({ enabled: modelActive });
  const showBackground = useSidebarViewStore((state) => state.showBackground);
  const groupMode = useSidebarViewStore((state) => state.groupMode);
  const labelFilter = useSidebarViewStore((state) => state.labelFilter);
  const projectFilters = useSidebarViewStore((state) => state.projectFilters);
  const reconcileLabelFilter = useSidebarViewStore((state) => state.reconcileLabelFilter);
  const { hosts: labelHosts } = useLabelProjection();
  const collapsedProjectKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedProjectKeys,
  );
  const collapsedWorkspaceGroupKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedWorkspaceGroupKeys,
  );
  const pinnedCollapsed = useSidebarCollapsedSectionsStore((state) => state.collapsedPinned);
  const pinnedWorkspaceOrder = useSidebarOrderStore((state) => state.pinnedWorkspaceOrder);
  const toggleProjectCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.toggleProjectCollapsed,
  );
  const availableLabelIds = useMemo(
    () => labelHosts.flatMap((host) => host.labels.map((label) => label.id)),
    [labelHosts],
  );
  const catalogsAuthoritative = hasAuthoritativeLabelCatalog(labelHosts);
  useEffect(() => {
    if (!catalogsAuthoritative) return;
    reconcileLabelFilter(availableLabelIds);
  }, [availableLabelIds, catalogsAuthoritative, reconcileLabelFilter]);
  const hasActiveLabelFilter = hasActiveSidebarLabelFilter(labelFilter);
  const resolvedProjectFilters = useMemo(
    () =>
      resolveActiveProjectFilters(
        projectFilters,
        new Set(list.projects.map((project) => project.viewKey)),
      ),
    [projectFilters, list.projects],
  );
  const hasActiveProjectFilter = resolvedProjectFilters.length > 0;
  // The project filter is deliberately absent from this gate. It reads `projectViewKey`, which
  // lives on the project and the placement, so it can narrow the project list without hydrating
  // anything; the label filter reads each workspace's root chats, which are keyed by an entry.
  // Hydration opens a live session-store subscription over every workspace on every visible host,
  // so widening this for a filter that does not need it costs a retained-but-inactive sidebar
  // real work.
  // Hardware keyboard navigation needs the same filtered targets while the sidebar is hidden.
  const needsWorkspaceEntries = groupMode !== "project" || hasActiveLabelFilter;
  const workspaceEntriesByKey = useSidebarWorkspaceEntries(
    list.workspacePlacements,
    modelActive || needsWorkspaceEntries,
  );
  // Labels live on chats. A workspace matches when any root chat in it carries the label, so the
  // filter reads each workspace's root chat ids — only while a filter is active, because the
  // session store ticks on every stream event.
  const rootChatIdsByWorkspace = useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      if (!hasActiveLabelFilter) return NO_ROOT_CHATS;
      const result = new Map<string, string[]>();
      for (const workspace of workspaceEntriesByKey.values()) {
        result.set(
          workspace.workspaceKey,
          selectWorkspaceRootChats(state.sessions, workspace.serverId, workspace.workspaceId).map(
            (chat) => chat.agentId,
          ),
        );
      }
      return result;
    },
    equal,
  );
  const labelHostsById = useLabelStore((state) => state.hosts);
  const filteredWorkspaceEntriesByKey = useMemo(() => {
    const byProject = filterWorkspacesByProjects({
      workspaces: [...workspaceEntriesByKey.values()],
      projectFilters: resolvedProjectFilters,
    });
    const filtered = filterWorkspacesByLabels({
      workspaces: byProject.filter((workspace) => showBackground || !workspace.background),
      ...labelFilter,
      labelIdsOf: (workspace) =>
        (rootChatIdsByWorkspace.get(workspace.workspaceKey) ?? []).flatMap(
          (agentId) =>
            labelHostsById[workspace.serverId]?.assignments[
              labelTargetKey({ kind: "agent", agentId })
            ] ?? [],
        ),
    });
    return new Map(filtered.map((workspace) => [workspace.workspaceKey, workspace]));
  }, [
    showBackground,
    labelFilter,
    labelHostsById,
    rootChatIdsByWorkspace,
    resolvedProjectFilters,
    workspaceEntriesByKey,
  ]);
  const visibleWorkspaceKeys = useMemo(
    () => new Set(filteredWorkspaceEntriesByKey.keys()),
    [filteredWorkspaceEntriesByKey],
  );
  // The two filters prune differently on purpose. The project filter is a membership test on the
  // project itself, so a project you filtered TO survives even with no workspaces — it still owns
  // a header row you can create your first workspace under. The label filter can only ask about
  // workspaces, so a project it empties has nothing left to show.
  const filteredProjects = useMemo(() => {
    let projects = list.projects;
    if (hasActiveProjectFilter) {
      const included = new Set(resolvedProjectFilters);
      projects = projects.filter((project) => included.has(project.viewKey));
    }
    if (hasActiveLabelFilter || !showBackground) {
      projects = projects.flatMap((project) => {
        const workspaces = project.workspaces.filter((workspace) =>
          visibleWorkspaceKeys.has(workspace.workspaceKey),
        );
        return workspaces.length > 0 || (!hasActiveLabelFilter && project.workspaces.length === 0)
          ? [workspaces.length === project.workspaces.length ? project : { ...project, workspaces }]
          : [];
      });
    }
    return projects;
  }, [
    showBackground,
    hasActiveLabelFilter,
    hasActiveProjectFilter,
    resolvedProjectFilters,
    list.projects,
    visibleWorkspaceKeys,
  ]);
  const pinnedKeys = usePinnedSidebarKeys(filteredProjects);
  const projectionInput = useMemo(
    () => ({
      projects: filteredProjects,
      pinnedKeys,
      pinnedWorkspaceOrder,
      workspaceEntriesByKey: filteredWorkspaceEntriesByKey,
      projectNamesByViewKey: list.projectNamesByViewKey,
      groupMode,
      pinnedCollapsed,
      collapsedProjectKeys,
      collapsedWorkspaceGroupKeys,
      t,
    }),
    [
      collapsedProjectKeys,
      collapsedWorkspaceGroupKeys,
      groupMode,
      list.projectNamesByViewKey,
      filteredProjects,
      pinnedCollapsed,
      pinnedKeys,
      pinnedWorkspaceOrder,
      filteredWorkspaceEntriesByKey,
      t,
    ],
  );
  const projection = useMemo(() => buildSidebarProjection(projectionInput), [projectionInput]);
  const value = useMemo(
    () => ({
      ...list,
      projects: filteredProjects,
      allProjects: list.projects,
      resolvedProjectFilters,
      hasProjectsBeforeFilter: list.projects.length > 0,
      workspaceEntriesByKey: filteredWorkspaceEntriesByKey,
      groupMode,
      workspaceGroups: projection.workspaceGroups,
      projectIconTargets: projection.projectIconTargets,
      pinnedGroups: projection.pinnedGroups,
      collapsedProjectKeys,
      toggleProjectCollapsed,
      shortcutModel: projection.shortcutModel,
    }),
    [
      resolvedProjectFilters,
      collapsedProjectKeys,
      groupMode,
      list,
      filteredProjects,
      projection,
      toggleProjectCollapsed,
      filteredWorkspaceEntriesByKey,
    ],
  );

  return <SidebarModelContext.Provider value={value}>{children}</SidebarModelContext.Provider>;
}

export function useSidebarModel(): SidebarModel {
  const model = useContext(SidebarModelContext);
  if (!model) throw new Error("SidebarModelProvider is required");
  return model;
}
