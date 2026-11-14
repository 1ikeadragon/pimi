import { useCallback } from "react";
import { useTranslation } from "@/i18n/use-translation";
import { useMutation } from "@tanstack/react-query";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { resolveChatTitle, useWorkspaceChat, useWorkspacePrimaryChat } from "@/chats/primary-chat";

// The subset of a workspace the rename dialog needs. Narrower than SidebarWorkspaceEntry so the
// command center can build one from the active route selection without a sidebar row.
export interface RenamableWorkspace {
  serverId: string;
  workspaceId: string;
  name: string;
  title?: string | null;
}

export interface WorkspaceRenameModalProps {
  visible: boolean;
  workspace: RenamableWorkspace;
  onClose: () => void;
  /**
   * Prefix for the modal's testIDs. The sidebar callers must keep passing
   * `sidebar-workspace-rename-modal-${workspaceKey}` — e2e/browser/sidebar-workspace-rename.spec.ts
   * builds its locators from exactly that prefix.
   */
  testID?: string;
  /** The chat to rename: the workspace's primary chat (a sidebar row) or the one it is showing. */
  chat?: "primary" | "shown";
}

/**
 * Renames a chat. The chat's title is its agent's name. The workspace title is the fallback the
 * sidebar uses before the primary agent has one, so renaming the primary chat writes both: the
 * tab, the sidebar row and the header then agree and the name survives a restart. Renaming any
 * other chat in the workspace writes only its agent. Owns every rename string, so a
 * caller only tracks its own open/closed boolean. Errors surface inline inside
 * AdaptiveRenameModal; the dialog stays open.
 */
export function WorkspaceRenameModal({
  visible,
  workspace,
  onClose,
  testID,
  chat = "primary",
}: WorkspaceRenameModalProps) {
  const { t } = useTranslation();
  const targetChat = useWorkspaceChat(workspace.serverId, workspace.workspaceId, chat);
  const primaryChat = useWorkspacePrimaryChat(workspace.serverId, workspace.workspaceId);
  const targetAgentId = targetChat?.agentId ?? null;
  const writesWorkspaceTitle = !targetChat || targetChat.agentId === primaryChat?.agentId;
  const currentTitle = resolveChatTitle({
    primaryTitle: targetChat?.title,
    workspaceTitle: workspace.title ?? workspace.name,
    fallback: workspace.name,
  });

  const renameMutation = useMutation({
    mutationFn: async (title: string) => {
      const client = getHostRuntimeStore().getClient(workspace.serverId);
      if (!client) {
        throw new Error(t("sidebar.workspace.toasts.hostDisconnected"));
      }
      if (targetAgentId && title.length > 0) {
        await client.updateAgent(targetAgentId, { name: title });
      }
      if (writesWorkspaceTitle) {
        await client.setWorkspaceTitle(workspace.workspaceId, title.length === 0 ? null : title);
      }
    },
  });
  const renameAsync = renameMutation.mutateAsync;

  const handleSubmit = useCallback(
    async (value: string) => {
      await renameAsync(value.trim());
    },
    [renameAsync],
  );

  return (
    <AdaptiveRenameModal
      visible={visible}
      title={t("sidebar.workspace.rename.title")}
      initialValue={currentTitle}
      placeholder={workspace.name}
      submitLabel={t("sidebar.workspace.rename.submit")}
      onClose={onClose}
      onSubmit={handleSubmit}
      testID={testID}
    />
  );
}
