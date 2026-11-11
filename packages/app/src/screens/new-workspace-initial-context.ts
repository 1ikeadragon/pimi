import {
  canCreateWorkspaceForHostProject,
  filterWorkspaceProjectsForHost,
  resolveHostProjectCandidate,
  type HostProjectListItem,
} from "@/projects/host-projects";
import type { HostRuntimeConnectionStatus } from "@/runtime/host-runtime";

export interface NewWorkspaceInitialServerInput {
  allServerIds: readonly string[];
  routeServerId: string | null | undefined;
  lastActiveProject: HostProjectListItem | null;
  projects: readonly HostProjectListItem[];
  hostConnectionStatusByServerId: ReadonlyMap<string, HostRuntimeConnectionStatus>;
}

function knownServerId(serverIds: ReadonlySet<string>, serverId: string | null | undefined) {
  const normalized = serverId?.trim() ?? "";
  return normalized && serverIds.has(normalized) ? normalized : null;
}

function canUseProjectForServer(input: {
  project: HostProjectListItem;
  projects: readonly HostProjectListItem[];
  serverId: string;
}) {
  const selectableProjects = filterWorkspaceProjectsForHost({
    projects: input.projects,
    serverId: input.serverId,
  });
  const project =
    resolveHostProjectCandidate({
      candidate: input.project,
      projects: selectableProjects,
      serverId: input.serverId,
    }) ?? input.project;
  return canCreateWorkspaceForHostProject({
    project,
    serverId: input.serverId,
  });
}

function findLastActiveProjectServerId(input: {
  serverIds: ReadonlySet<string>;
  lastActiveProject: HostProjectListItem | null;
  projects: readonly HostProjectListItem[];
}) {
  if (!input.lastActiveProject) {
    return null;
  }

  for (const host of input.lastActiveProject.hosts) {
    if (!input.serverIds.has(host.serverId)) {
      continue;
    }
    if (
      canUseProjectForServer({
        project: input.lastActiveProject,
        projects: input.projects,
        serverId: host.serverId,
      })
    ) {
      return host.serverId;
    }
  }

  return null;
}

function hasSelectableProject(input: {
  projects: readonly HostProjectListItem[];
  serverId: string;
}) {
  return input.projects.some((project) =>
    canUseProjectForServer({
      project,
      projects: input.projects,
      serverId: input.serverId,
    }),
  );
}

function isOnline(
  statuses: ReadonlyMap<string, HostRuntimeConnectionStatus>,
  serverId: string,
): boolean {
  return statuses.get(serverId) === "online";
}

function isKnownUnreachable(
  statuses: ReadonlyMap<string, HostRuntimeConnectionStatus>,
  serverId: string,
): boolean {
  const status = statuses.get(serverId);
  return status === "offline" || status === "error";
}

export function resolveNewWorkspaceInitialServerId(input: NewWorkspaceInitialServerInput): string {
  const serverIds = new Set(input.allServerIds);
  const routeServerId = knownServerId(serverIds, input.routeServerId);
  if (routeServerId) {
    return routeServerId;
  }

  const onlineServerIds = input.allServerIds.filter((serverId) =>
    isOnline(input.hostConnectionStatusByServerId, serverId),
  );
  const onlineServerIdsWithProjects = onlineServerIds.filter((serverId) =>
    hasSelectableProject({
      projects: input.projects,
      serverId,
    }),
  );
  const serverIdsWithProjects = input.allServerIds.filter((serverId) =>
    hasSelectableProject({
      projects: input.projects,
      serverId,
    }),
  );

  const lastActiveProjectServerId = findLastActiveProjectServerId({
    serverIds,
    lastActiveProject: input.lastActiveProject,
    projects: input.projects,
  });
  if (
    lastActiveProjectServerId &&
    isOnline(input.hostConnectionStatusByServerId, lastActiveProjectServerId)
  ) {
    return lastActiveProjectServerId;
  }

  if (onlineServerIdsWithProjects.length > 0) {
    return onlineServerIdsWithProjects[0] ?? "";
  }
  if (onlineServerIds.length === 1) {
    return onlineServerIds[0] ?? "";
  }

  if (onlineServerIds.length > 0) {
    return onlineServerIds[0] ?? "";
  }

  const reachableServerIdsWithProjects = serverIdsWithProjects.filter(
    (serverId) => !isKnownUnreachable(input.hostConnectionStatusByServerId, serverId),
  );
  if (reachableServerIdsWithProjects.length === 1) {
    return reachableServerIdsWithProjects[0] ?? "";
  }

  if (lastActiveProjectServerId) {
    return lastActiveProjectServerId;
  }

  if (serverIdsWithProjects.length === 1) {
    return serverIdsWithProjects[0] ?? "";
  }

  return input.allServerIds[0] ?? "";
}

export function resolveNewWorkspaceAutomaticServerId(
  input: NewWorkspaceInitialServerInput & {
    currentServerId: string | null | undefined;
    nextServerId: string | null | undefined;
  },
): string {
  const serverIds = new Set(input.allServerIds);
  const currentServerId = knownServerId(serverIds, input.currentServerId);
  const nextServerId = knownServerId(serverIds, input.nextServerId) ?? input.allServerIds[0] ?? "";
  if (!currentServerId || currentServerId === nextServerId) {
    return nextServerId;
  }

  if (
    isOnline(input.hostConnectionStatusByServerId, nextServerId) &&
    !isOnline(input.hostConnectionStatusByServerId, currentServerId)
  ) {
    return nextServerId;
  }

  const routeServerId = knownServerId(serverIds, input.routeServerId);
  if (routeServerId === nextServerId) {
    return nextServerId;
  }

  const lastActiveProjectServerId = findLastActiveProjectServerId({
    serverIds,
    lastActiveProject: input.lastActiveProject,
    projects: input.projects,
  });
  const hasOnlineServer = input.allServerIds.some((serverId) =>
    isOnline(input.hostConnectionStatusByServerId, serverId),
  );
  if (
    lastActiveProjectServerId === nextServerId &&
    (isOnline(input.hostConnectionStatusByServerId, nextServerId) || !hasOnlineServer)
  ) {
    return nextServerId;
  }

  const currentHasProject = hasSelectableProject({
    projects: input.projects,
    serverId: currentServerId,
  });
  const nextHasProject = hasSelectableProject({
    projects: input.projects,
    serverId: nextServerId,
  });
  if (
    isKnownUnreachable(input.hostConnectionStatusByServerId, currentServerId) &&
    nextHasProject &&
    !isKnownUnreachable(input.hostConnectionStatusByServerId, nextServerId)
  ) {
    return nextServerId;
  }
  if (
    !currentHasProject &&
    nextHasProject &&
    (!isOnline(input.hostConnectionStatusByServerId, currentServerId) ||
      isOnline(input.hostConnectionStatusByServerId, nextServerId))
  ) {
    return nextServerId;
  }

  return currentServerId;
}
