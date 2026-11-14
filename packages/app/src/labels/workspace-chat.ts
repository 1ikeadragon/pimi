import { useMemo } from "react";
import { useWorkspacePrimaryChat } from "@/chats/primary-chat";
import type { Label, LabelTarget } from "@pimi/protocol/labels";
import { useTargetLabels } from "./store";

/**
 * The label target a workspace row stands for: its primary chat, the first root chat in it.
 * Null while the workspace has no chat. Labels are not on workspaces; a row borrows its primary
 * chat's.
 */
export function useWorkspacePrimaryChatTarget(
  serverId: string | null | undefined,
  workspaceId: string,
): LabelTarget | null {
  const primary = useWorkspacePrimaryChat(serverId, workspaceId);
  const agentId = primary?.agentId;
  return useMemo(() => (agentId ? { kind: "agent", agentId } : null), [agentId]);
}

/** The primary chat's labels, resolved against the workspace's host. */
export function useWorkspaceRowLabels(
  serverId: string | null | undefined,
  workspaceId: string,
): readonly Label[] {
  const target = useWorkspacePrimaryChatTarget(serverId, workspaceId);
  return useTargetLabels(serverId ?? "", target);
}
