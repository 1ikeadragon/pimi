import type { TFunction } from "i18next";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { getStatusBucketLabel } from "@/hooks/sidebar-status-view-model";
import { resolveChatTitle, useWorkspacePrimaryChat } from "@/chats/primary-chat";

/**
 * The row's label is the chat's title, the same string its tab shows. The workspace title only
 * covers a workspace whose chat has no name yet.
 */
export function useSidebarChatTitle(
  workspace: Pick<SidebarWorkspaceEntry, "serverId" | "workspaceId" | "name">,
): string {
  const primary = useWorkspacePrimaryChat(workspace.serverId, workspace.workspaceId);
  return resolveChatTitle({
    primaryTitle: primary?.title,
    workspaceTitle: workspace.name,
    fallback: "New chat",
  });
}

export function resolveSidebarWorkspaceAccessibilityLabel(input: {
  workspace: Pick<SidebarWorkspaceEntry, "statusBucket">;
  chatTitle: string;
  leadingProjectName?: string | null;
  hostBadgeLabel?: string | null;
  pullRequestLabel?: string | null;
  serviceLabel?: string | null;
  t: TFunction;
}): string {
  return [
    input.leadingProjectName,
    input.chatTitle,
    input.hostBadgeLabel,
    input.pullRequestLabel,
    input.serviceLabel,
    input.workspace.statusBucket === "done"
      ? null
      : getStatusBucketLabel(input.workspace.statusBucket, input.t),
  ]
    .filter((label): label is string => Boolean(label))
    .join(", ");
}
