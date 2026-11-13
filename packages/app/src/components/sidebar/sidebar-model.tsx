import { useTranslation } from "@/i18n/use-translation";
import React, { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { getParentAddressFromLabels } from "@pimi/protocol/agent-labels";
import { PIMI_TASK_WORKER_LABEL } from "@pimi/protocol/pimi-task";
import { useShallow } from "zustand/react/shallow";
import { usePimiLinkedLabels } from "@/desktop/pimi-labels";
import { getDesktopHost } from "@/desktop/host";
import { useSessionStore, type Agent } from "@/stores/session-store";
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
  hasAuthoritativeWorkspaceLabelCatalog,
  useWorkspaceLabelProjection,
} from "@/workspace-labels";

interface SidebarModel extends SidebarWorkspacesListResult {
  pimiTaskBranches: ReadonlyMap<string, PimiTaskBranch[]>;
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

const SidebarModelContext = createContext<SidebarModel | null>(null);

interface PimiTaskBranch {
  worker: Agent;
  parent: Agent;
  workspace: SidebarWorkspaceEntry;
}

function visibleTaskBranch(
  worker: Agent,
  agents: ReadonlyMap<string, Agent>,
  workspaces: ReadonlyMap<string, SidebarWorkspaceEntry>,
  workspaceSizes: ReadonlyMap<string, number>,
  groupMode: SidebarGroupMode,
) {
  if (!worker.labels?.[PIMI_TASK_WORKER_LABEL] || worker.archivedAt || worker.background) return;
  if (!worker.workspaceId || workspaceSizes.get(worker.workspaceId) !== 1) return;
  const address = getParentAddressFromLabels(worker.labels, worker.serverId);
  if (address?.serverId !== worker.serverId) return;
  const parent = agents.get(address.agentId);
  if (!parent?.workspaceId || parent.archivedAt || parent.background) return;
  if (worker.workspaceId === parent.workspaceId) return;
  const workspace = workspaces.get(`${worker.serverId}:${worker.workspaceId}`);
  const parentKey = `${parent.serverId}:${parent.workspaceId}`;
  const parentWorkspace = workspaces.get(parentKey);
  if (!workspace || workspace.pinnedAt || !parentWorkspace) return;
  // In Status, a child that needs review must stay visible in its own bucket.
  if (groupMode === "status" && workspace.statusBucket !== parentWorkspace.statusBucket) return;
  return { branch: { worker, parent, workspace }, parentKey };
}

function projectPimiTaskBranches(
  agentMaps: ReadonlyArray<ReadonlyMap<string, Agent>>,
  workspaces: ReadonlyMap<string, SidebarWorkspaceEntry>,
  groupMode: SidebarGroupMode,
) {
  const branches = new Map<string, PimiTaskBranch[]>();
  const nestedKeys = new Set<string>();
  for (const agents of agentMaps) {
    const workspaceSizes = new Map<string, number>();
    for (const agent of agents.values()) {
      if (!agent.workspaceId || agent.archivedAt || agent.background) continue;
      workspaceSizes.set(agent.workspaceId, (workspaceSizes.get(agent.workspaceId) ?? 0) + 1);
    }
    for (const worker of agents.values()) {
      const nested = visibleTaskBranch(worker, agents, workspaces, workspaceSizes, groupMode);
      if (!nested) continue;
      const { branch, parentKey } = nested;
      nestedKeys.add(branch.workspace.workspaceKey);
      const siblings = branches.get(parentKey);
      if (siblings) siblings.push(branch);
      else branches.set(parentKey, [branch]);
    }
  }
  return { branches, nestedKeys };
}

export function usePimiTaskBranches(workspaceKey: string) {
  return useContext(SidebarModelContext)?.pimiTaskBranches.get(workspaceKey);
}

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
  const showTaskBranches = modelActive && Boolean(getDesktopHost()?.showPimiWorkspace);
  const agentMaps = useSessionStore(
    useShallow((state) =>
      showTaskBranches ? Object.values(state.sessions).map((session) => session.agents) : [],
    ),
  );
  const list = useSidebarWorkspacesList({ enabled: modelActive });
  const showBackground = useSidebarViewStore((state) => state.showBackground);
  const groupMode = useSidebarViewStore((state) => state.groupMode);
  const labelFilter = useSidebarViewStore((state) => state.labelFilter);
  const projectFilters = useSidebarViewStore((state) => state.projectFilters);
  const reconcileLabelFilter = useSidebarViewStore((state) => state.reconcileLabelFilter);
  const { hosts: labelHosts } = useWorkspaceLabelProjection();
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
  const availableLabelNames = useMemo(
    () => labelHosts.flatMap((host) => host.labels.map((label) => label.name)),
    [labelHosts],
  );
  const hasAuthoritativeLabelCatalog = hasAuthoritativeWorkspaceLabelCatalog(labelHosts);
  useEffect(() => {
    if (!hasAuthoritativeLabelCatalog) return;
    reconcileLabelFilter(availableLabelNames);
  }, [availableLabelNames, hasAuthoritativeLabelCatalog, reconcileLabelFilter]);
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
  // anything; the label filter reads `labels`, which only exists on an entry. Hydration opens a
  // live session-store subscription over every workspace on every visible host, so widening this
  // for a filter that does not need it costs a retained-but-inactive sidebar real work.
  // Hardware keyboard navigation needs the same filtered targets while the sidebar is hidden.
  const needsWorkspaceEntries = groupMode !== "project" || hasActiveLabelFilter;
  const workspaceEntriesByKey = useSidebarWorkspaceEntries(
    list.workspacePlacements,
    modelActive || needsWorkspaceEntries,
  );
  const linkedLabels = usePimiLinkedLabels();
  const filteredWorkspaceEntriesByKey = useMemo(() => {
    const byProject = filterWorkspacesByProjects({
      workspaces: [...workspaceEntriesByKey.values()],
      projectFilters: resolvedProjectFilters,
    });
    const filtered = filterWorkspacesByLabels({
      workspaces: byProject.filter((workspace) => showBackground || !workspace.background),
      ...labelFilter,
      linkedLabels: (workspace) =>
        linkedLabels?.serverId === workspace.serverId
          ? linkedLabels.workspaces[workspace.workspaceId]
          : undefined,
    });
    return new Map(filtered.map((workspace) => [workspace.workspaceKey, workspace]));
  }, [showBackground, labelFilter, linkedLabels, resolvedProjectFilters, workspaceEntriesByKey]);
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
  const taskTree = useMemo(
    () => projectPimiTaskBranches(agentMaps, filteredWorkspaceEntriesByKey, groupMode),
    [agentMaps, filteredWorkspaceEntriesByKey, groupMode],
  );
  const rootProjects = useMemo(() => {
    if (!taskTree.nestedKeys.size) return filteredProjects;
    return filteredProjects.flatMap((project) => {
      const workspaces = project.workspaces.filter(
        (workspace) => !taskTree.nestedKeys.has(workspace.workspaceKey),
      );
      if (workspaces.length === project.workspaces.length) return [project];
      return workspaces.length ? [{ ...project, workspaces }] : [];
    });
  }, [filteredProjects, taskTree.nestedKeys]);
  const rootWorkspaces = useMemo(
    () =>
      taskTree.nestedKeys.size
        ? new Map(
            [...filteredWorkspaceEntriesByKey].filter(([key]) => !taskTree.nestedKeys.has(key)),
          )
        : filteredWorkspaceEntriesByKey,
    [filteredWorkspaceEntriesByKey, taskTree.nestedKeys],
  );
  const projectionInput = useMemo(
    () => ({
      projects: rootProjects,
      pinnedKeys,
      pinnedWorkspaceOrder,
      workspaceEntriesByKey: rootWorkspaces,
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
      rootProjects,
      pinnedCollapsed,
      pinnedKeys,
      pinnedWorkspaceOrder,
      rootWorkspaces,
      t,
    ],
  );
  const projection = useMemo(() => buildSidebarProjection(projectionInput), [projectionInput]);
  const value = useMemo(
    () => ({
      ...list,
      projects: rootProjects,
      pimiTaskBranches: taskTree.branches,
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
      rootProjects,
      taskTree.branches,
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
