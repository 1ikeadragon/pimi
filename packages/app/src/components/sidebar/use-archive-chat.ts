import { useCallback } from "react";
import { selectWorkspaceRootChats } from "@/chats/primary-chat";
import { useTranslation } from "@/i18n/use-translation";
import { useSessionStore } from "@/stores/session-store";
import { confirmDialog } from "@/utils/confirm-dialog";
import {
  useWorkspaceArchive,
  type ArchiveWorkspaceInput,
  type WorkspaceArchiveController,
} from "@/workspace/use-workspace-archive";

/**
 * Archiving a chat row archives its workspace record, which also archives every other chat that
 * shares it. When there are others, say so before doing it.
 */
export function useArchiveChat(input: ArchiveWorkspaceInput): WorkspaceArchiveController {
  const { t } = useTranslation();
  const { serverId, workspaceId } = input;
  const controller = useWorkspaceArchive(input);
  const archive = controller.archive;

  const archiveWithSiblingWarning = useCallback(() => {
    void (async () => {
      const siblingCount = Math.max(
        0,
        selectWorkspaceRootChats(useSessionStore.getState().sessions, serverId, workspaceId)
          .length - 1,
      );
      if (siblingCount > 0) {
        const confirmed = await confirmDialog({
          title: t("sidebar.workspace.actions.archive"),
          message: t("sidebar.workspace.confirmations.archiveSiblingChats", {
            count: siblingCount,
          }),
          confirmLabel: t("sidebar.workspace.actions.archive"),
          cancelLabel: t("sidebar.project.confirmations.cancel"),
          destructive: true,
        });
        if (!confirmed) return;
      }
      archive();
    })();
  }, [archive, serverId, t, workspaceId]);

  return { archive: archiveWithSiblingWarning };
}
