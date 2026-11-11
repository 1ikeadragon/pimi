import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { revealWorkspaceTab } from "@/workspace-tabs/navigation";
import {
  createWorkspaceFileTabTarget,
  normalizeWorkspaceFileLocation,
  type WorkspaceFileLocation,
} from "./index";

/** Opens a file tab at a line, or moves an already open tab there, and reveals it. */
export function openWorkspaceFileLocation(input: {
  serverId: string;
  workspaceId: string;
  location: WorkspaceFileLocation;
}): void {
  const location = normalizeWorkspaceFileLocation(input.location);
  if (!location) return;
  const workspaceKey = buildWorkspaceTabPersistenceKey({
    serverId: input.serverId,
    workspaceId: input.workspaceId,
  });
  if (!workspaceKey) return;
  const tabId = useWorkspaceLayoutStore.getState().openTab({
    workspaceKey,
    target: createWorkspaceFileTabTarget(location),
    intent: "reveal",
  });
  if (tabId) revealWorkspaceTab(workspaceKey, tabId);
}
