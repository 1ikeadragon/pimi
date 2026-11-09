import { useMemo } from "react";
import { useSessionStore } from "@/stores/session-store";
import { useDraftStore } from "@/stores/draft-store";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { revealWorkspaceTab } from "@/workspace-tabs/navigation";
import { resolveFocusedChatTarget } from "@/composer/focused-chat-target";
import { generateMessageId } from "@/types/stream";
import { AnnotationAttachmentSchema, type AnnotationCapture } from "./model";

export interface AnnotationTarget {
  serverId: string;
  draftKey: string;
  agentId?: string;
  workspaceKey?: string;
  tabId?: string;
}

export function isAnnotationTargetAvailable(target: AnnotationTarget): boolean {
  if (target.workspaceKey && target.tabId) {
    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[target.workspaceKey];
    const tab =
      layout && collectAllTabs(layout.root).find((candidate) => candidate.tabId === target.tabId);
    if (!tab || (tab.target.kind !== "agent" && tab.target.kind !== "draft")) return false;
    const key =
      tab.target.kind === "agent"
        ? buildDraftStoreKey({
            serverId: target.serverId,
            agentId: tab.target.agentId,
          })
        : buildDraftStoreKey({
            serverId: target.serverId,
            agentId: tab.tabId,
            draftId: tab.target.draftId,
          });
    if (key !== target.draftKey) return false;
  }
  if (target.agentId) {
    const session = useSessionStore.getState().sessions[target.serverId];
    const agent = session?.agents.get(target.agentId) ?? session?.agentDetails.get(target.agentId);
    return Boolean(agent && !agent.archivedAt);
  }
  return Boolean(target.workspaceKey && target.tabId);
}

export async function addAnnotationToChat(
  target: AnnotationTarget,
  capture: AnnotationCapture,
  note: string,
) {
  await useDraftStore.getState().hydrateDraftInput({ draftKey: target.draftKey });
  if (!isAnnotationTargetAvailable(target))
    throw new Error("The target chat is no longer available.");
  await useDraftStore.getState().attachAnnotation({
    draftKey: target.draftKey,
    attachment: AnnotationAttachmentSchema.parse({
      kind: "annotation",
      id: generateMessageId(),
      ...capture,
      note,
    }),
  });
  if (target.workspaceKey && target.tabId) revealWorkspaceTab(target.workspaceKey, target.tabId);
}

/** Match the file panel's existing add-to-chat routing, then reject archived/unknown chats. */
export function useFileAnnotationTarget(
  serverId: string,
  workspaceId: string,
): AnnotationTarget | null {
  const workspaceKey = buildWorkspaceTabPersistenceKey({
    serverId,
    workspaceId,
  });
  const layout = useWorkspaceLayoutStore((state) =>
    workspaceKey ? state.layoutByWorkspace[workspaceKey] : undefined,
  );
  const target = useMemo(() => {
    const focused = resolveFocusedChatTarget({ serverId, layout });
    if (!focused || !layout || !workspaceKey) return null;
    const tab = collectAllTabs(layout.root).find((candidate) => candidate.tabId === focused.tabId);
    return {
      ...focused,
      serverId,
      workspaceKey,
      ...(tab?.target.kind === "agent" ? { agentId: tab.target.agentId } : {}),
    };
  }, [serverId, workspaceKey, layout]);
  const available = useSessionStore(() => target !== null && isAnnotationTargetAvailable(target));
  return available ? target : null;
}
