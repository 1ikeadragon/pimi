import { useMemo } from "react";
import { useWorkspaceChat } from "@/chats/primary-chat";
import type { Label, LabelTarget } from "@pimi/protocol/labels";
import { useTargetLabels } from "./store";

/**
 * The label target a workspace stands for: its primary chat (a sidebar row) or the chat it is
 * showing (the header). Null while the workspace has no chat. Labels are not on workspaces; they
 * borrow the chat's.
 */
export function useWorkspaceChatTarget(
  serverId: string | null | undefined,
  workspaceId: string,
  which: "primary" | "shown" = "primary",
): LabelTarget | null {
  const chat = useWorkspaceChat(serverId, workspaceId, which);
  const agentId = chat?.agentId;
  return useMemo(() => (agentId ? { kind: "agent", agentId } : null), [agentId]);
}

/** The primary chat's labels, resolved against the workspace's host. */
export function useWorkspaceRowLabels(
  serverId: string | null | undefined,
  workspaceId: string,
): readonly Label[] {
  const target = useWorkspaceChatTarget(serverId, workspaceId);
  return useTargetLabels(serverId ?? "", target);
}
