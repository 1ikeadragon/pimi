import { useCallback } from "react";
import { selectWorkspaceRootChats } from "@/chats/primary-chat";
import { useArchiveAgent } from "@/hooks/use-archive-agent";
import { useSessionStore } from "@/stores/session-store";
import {
  useWorkspaceArchive,
  type ArchiveWorkspaceInput,
  type WorkspaceArchiveController,
} from "@/workspace/use-workspace-archive";

/**
 * Archiving a chat row archives its workspace record when that is the only chat in it. When the
 * record holds other root chats, only the row's primary chat is archived (its subagents follow
 * by parent label), so the others and the record stay.
 */
export function useArchiveChat(input: ArchiveWorkspaceInput): WorkspaceArchiveController {
  const { serverId, workspaceId } = input;
  const controller = useWorkspaceArchive(input);
  const recordArchive = controller.archive;
  const { archiveAgent } = useArchiveAgent();

  const archive = useCallback(() => {
    const roots = selectWorkspaceRootChats(
      useSessionStore.getState().sessions,
      serverId,
      workspaceId,
    );
    if (roots.length >= 2) {
      void archiveAgent({ serverId, agentId: roots[0]!.agentId });
      return;
    }
    recordArchive();
  }, [archiveAgent, recordArchive, serverId, workspaceId]);

  return { archive };
}
