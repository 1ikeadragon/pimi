import { useCallback, useMemo, useSyncExternalStore } from "react";
import { usePathname } from "expo-router";
import type {
  PluginActiveContext,
  PluginProjectSnapshot,
  PluginTimelineEntry,
} from "@pimi/plugin/client";
import type { PluginAgentSnapshot, PluginWorkspaceSnapshot } from "@pimi/plugin";
import { useSessionStore } from "@/stores/session-store";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";
import {
  parseHostAgentRouteFromPathname,
  parseHostWorkspaceRouteFromPathname,
} from "@/utils/host-routes";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";
import {
  createPluginAgentSnapshot,
  createPluginWorkspaceSnapshot,
} from "../client-state/snapshots";
import { useInstallation } from "./context";

const EMPTY: readonly never[] = Object.freeze([]);

/** Reuses `previous` when every element is the same reference, so selectors stay quiet. */
function stable<Item>(previous: readonly Item[], next: readonly Item[]): readonly Item[] {
  if (previous.length === next.length && previous.every((item, index) => item === next[index])) {
    return previous;
  }
  return next;
}

/**
 * Subscribes to the session store and returns `read()`'s array, keeping the previous reference
 * while no element changed. `read` must be pure over store state.
 */
function useStoreArray<Item>(read: () => readonly Item[]): readonly Item[] {
  const cache = useMemo(() => ({ value: EMPTY as readonly Item[] }), []);
  const getSnapshot = useCallback(() => {
    cache.value = stable(cache.value, read());
    return cache.value;
  }, [cache, read]);
  return useSyncExternalStore(useSessionStore.subscribe, getSnapshot, getSnapshot);
}

export function useWorkspaces(serverId?: string): readonly PluginWorkspaceSnapshot[] {
  const installation = useInstallation();
  const target = serverId ?? installation.serverId;
  const read = useCallback((): readonly PluginWorkspaceSnapshot[] => {
    const workspaces = useSessionStore.getState().sessions[target]?.workspaces;
    if (!workspaces) return EMPTY;
    return [...workspaces.values()].map((workspace) => createPluginWorkspaceSnapshot(workspace));
  }, [target]);
  return useStoreArray(read);
}

function projectOf(workspace: WorkspaceDescriptor): PluginProjectSnapshot {
  return {
    id: workspace.projectId,
    displayName: workspace.projectDisplayName,
    rootPath: workspace.projectRootPath,
    kind: workspace.projectKind,
  };
}

const projectSnapshots = new Map<string, PluginProjectSnapshot>();
function internProject(project: PluginProjectSnapshot): PluginProjectSnapshot {
  const key = `${project.id}\0${project.displayName}\0${project.rootPath}\0${project.kind}`;
  const existing = projectSnapshots.get(key);
  if (existing) return existing;
  const frozen = Object.freeze(project);
  projectSnapshots.set(key, frozen);
  return frozen;
}

/** Projects that have at least one workspace on the host. */
export function useProjects(serverId?: string): readonly PluginProjectSnapshot[] {
  const installation = useInstallation();
  const target = serverId ?? installation.serverId;
  const read = useCallback((): readonly PluginProjectSnapshot[] => {
    const workspaces = useSessionStore.getState().sessions[target]?.workspaces;
    if (!workspaces) return EMPTY;
    const byId = new Map<string, PluginProjectSnapshot>();
    for (const workspace of workspaces.values()) {
      if (!byId.has(workspace.projectId))
        byId.set(workspace.projectId, internProject(projectOf(workspace)));
    }
    return [...byId.values()];
  }, [target]);
  return useStoreArray(read);
}

export function useAgents(
  options: { serverId?: string; workspaceId?: string } = {},
): readonly PluginAgentSnapshot[] {
  const installation = useInstallation();
  const target = options.serverId ?? installation.serverId;
  const workspaceFilter = options.workspaceId;
  const read = useCallback((): readonly PluginAgentSnapshot[] => {
    const session = useSessionStore.getState().sessions[target];
    if (!session) return EMPTY;
    const snapshots: PluginAgentSnapshot[] = [];
    for (const agent of session.agents.values() as Iterable<Agent>) {
      const workspaceId = normalizeWorkspaceOpaqueId(agent.workspaceId);
      if (!workspaceId) continue;
      if (workspaceFilter !== undefined && workspaceId !== workspaceFilter) continue;
      snapshots.push(createPluginAgentSnapshot(agent, workspaceId));
    }
    return snapshots;
  }, [target, workspaceFilter]);
  return useStoreArray(read);
}

const timelineEntries = new WeakMap<StreamItem, PluginTimelineEntry>();
function entryOf(item: StreamItem): PluginTimelineEntry {
  const cached = timelineEntries.get(item);
  if (cached) return cached;
  let text: string | null = null;
  if (
    item.kind === "user_message" ||
    item.kind === "assistant_message" ||
    item.kind === "thought"
  ) {
    text = item.text;
  }
  const entry = Object.freeze({
    id: item.id,
    kind: item.kind,
    text,
    timestamp: "timestamp" in item ? item.timestamp.getTime() : 0,
  });
  timelineEntries.set(item, entry);
  return entry;
}

export function useAgentTimeline(
  agentId: string,
  options: { serverId?: string; tail?: number } = {},
): readonly PluginTimelineEntry[] {
  const installation = useInstallation();
  const target = options.serverId ?? installation.serverId;
  const tail = Math.max(1, Math.floor(options.tail ?? 50));
  const read = useCallback((): readonly PluginTimelineEntry[] => {
    const items = useSessionStore.getState().sessions[target]?.agentStreamTail.get(agentId);
    if (!items) return EMPTY;
    return items.slice(-tail).map(entryOf);
  }, [target, agentId, tail]);
  return useStoreArray(read);
}

export function useActiveContext(): PluginActiveContext {
  const pathname = usePathname();
  const route = useMemo(() => {
    const workspaceRoute = parseHostWorkspaceRouteFromPathname(pathname);
    const agentRoute = parseHostAgentRouteFromPathname(pathname);
    return {
      serverId: workspaceRoute?.serverId ?? agentRoute?.serverId ?? null,
      workspaceId: workspaceRoute?.workspaceId ?? null,
      agentId: agentRoute?.agentId ?? null,
      pathname,
    };
  }, [pathname]);
  return route;
}
