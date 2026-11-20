import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { collectAllTabs } from "@/stores/workspace-layout-actions";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { selectWorkspaceChat } from "./workspace-chat";

/**
 * Opens a chat from a row that stands for it (sidebar, chat shortcuts, Command Center). Closing a
 * tab only hides it from the layout, so a chat whose tab was closed brings that tab back, and a
 * chat whose agent is archived opens the agent with its Restore callout instead of a blank tab.
 * A chat whose tab is already open keeps the user's focused tab.
 */
export function openChat(input: { serverId: string; workspaceId: string }): void {
  const chat = selectWorkspaceChat(
    useSessionStore.getState().sessions,
    input.serverId,
    input.workspaceId,
  );
  const workspaceKey = buildWorkspaceTabPersistenceKey(input);
  const layout = workspaceKey
    ? useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]
    : undefined;
  const isChatTabOpen =
    chat !== null &&
    layout !== undefined &&
    collectAllTabs(layout.root).some(
      (tab) => tab.target.kind === "agent" && tab.target.agentId === chat.agentId,
    );
  navigateToWorkspace({
    ...input,
    ...(chat && !isChatTabOpen
      ? // An archived agent is not in the active directory; pinning keeps its tab open.
        { target: { kind: "agent", agentId: chat.agentId }, pin: chat.archived }
      : {}),
  });
}
