import { useCallback } from "react";
import { useTranslation } from "@/i18n/use-translation";
import { useMutation } from "@tanstack/react-query";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { resolveChatTitle, useWorkspacePrimaryChat } from "@/chats/primary-chat";

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
}

/**
 * Renames a chat. The chat's title is its primary agent's name, and the workspace title is the
 * fallback the sidebar uses before the agent has one, so both are written: the tab, the sidebar
 * row and the header then agree and the name survives a restart. Owns every rename string, so a
 * caller only tracks its own open/closed boolean. Errors surface inline inside
 * AdaptiveRenameModal; the dialog stays open.
 */
export function WorkspaceRenameModal({
  visible,
  workspace,
  onClose,
  testID,
}: WorkspaceRenameModalProps) {
  const { t } = useTranslation();
  const primaryChat = useWorkspacePrimaryChat(workspace.serverId, workspace.workspaceId);
  const primaryAgentId = primaryChat?.agentId ?? null;
  const currentTitle = resolveChatTitle({
    primaryTitle: primaryChat?.title,
    workspaceTitle: workspace.title ?? workspace.name,
    fallback: workspace.name,
  });

  const renameMutation = useMutation({
    mutationFn: async (title: string) => {
      const client = getHostRuntimeStore().getClient(workspace.serverId);
      if (!client) {
        throw new Error(t("sidebar.workspace.toasts.hostDisconnected"));
      }
      if (primaryAgentId && title.length > 0) {
        await client.updateAgent(primaryAgentId, { name: title });
      }
      await client.setWorkspaceTitle(workspace.workspaceId, title.length === 0 ? null : title);
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
