import { useEffect } from "react";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildDeterministicWorkspaceTabId } from "@/workspace-tabs/identity";

const ACTION_ITEMS_TAB_ID = buildDeterministicWorkspaceTabId({ kind: "action_items" });

/**
 * Keeps the workspace's Actions tab in step with the host's Action items setting. While it is off,
 * a default Explorer layout that brings the tab back has it removed again. The store selector only
 * walks the layout while the setting is off.
 */
export function useActionItemsTabSync(serverId: string, workspaceKey: string | null): void {
  const { config } = useDaemonConfig(serverId);
  const enabled = config ? config.metadataGeneration.actionItems !== false : null;
  const offTabPresent = useWorkspaceLayoutStore((state) => {
    if (!workspaceKey || !state.actionItemsOffByWorkspace[workspaceKey]) return false;
    const root = state.layoutByWorkspace[workspaceKey]?.root;
    return Boolean(root && collectAllTabs(root).some((tab) => tab.tabId === ACTION_ITEMS_TAB_ID));
  });
  useEffect(() => {
    if (!workspaceKey || enabled === null) return;
    useWorkspaceLayoutStore.getState().setActionItemsEnabled(workspaceKey, enabled);
  }, [workspaceKey, enabled, offTabPresent]);
}
