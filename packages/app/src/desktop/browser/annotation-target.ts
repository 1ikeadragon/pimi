import { useTranslation } from "react-i18next";
import { resolveBrowserAnnotationChat } from "@/composer/focused-chat-target";
import { useSessionStore } from "@/stores/session-store";
import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { useBrowserStore } from "./store";

interface BrowserAnnotationTargetInput {
  serverId: string;
  workspaceKey: string | null;
  /** The browser tab's own tab id, whose parent is the chat it was opened from. */
  tabId: string;
  browserId: string;
  /** Where annotations went before chats had their own scope, and where Attack runs still read. */
  workspaceScopeKey: string | null;
}

export interface BrowserAnnotationTarget {
  /** The scope an annotation made now is written to. */
  scopeKey: string | null;
  /** Names the chat the annotation attaches to, when the workspace has more than one. */
  chatLabel: string | null;
}

function useChatTabCount(workspaceKey: string | null): number {
  return useWorkspaceLayoutStore((state) => {
    const layout = workspaceKey ? state.layoutByWorkspace[workspaceKey] : undefined;
    if (!layout) return 0;
    return collectAllTabs(layout.root).filter(
      (tab) => tab.target.kind === "agent" || tab.target.kind === "draft",
    ).length;
  });
}

/**
 * Browser annotations attach to the chat the tab was opened from, so two chats in one workspace
 * do not both show the same pills. An Attack run's tabs, and any tab while the workbench is in
 * Attack mode, keep writing to the workspace scope that Attack reads.
 */
export function useBrowserAnnotationTarget(
  input: BrowserAnnotationTargetInput,
): BrowserAnnotationTarget {
  const { t } = useTranslation();
  const { serverId, workspaceKey, tabId, browserId, workspaceScopeKey } = input;
  const keepsWorkspaceScope = useWorkspaceLayoutStore((state) =>
    workspaceKey ? state.workbenchByWorkspace[workspaceKey]?.mode === "attack" : false,
  );
  const isAttackOwned = useBrowserStore((state) => state.browsersById[browserId]?.owner != null);
  const chatScopeKey = useWorkspaceLayoutStore((state) =>
    workspaceKey
      ? (resolveBrowserAnnotationChat({
          serverId,
          layout: state.layoutByWorkspace[workspaceKey],
          browserTabId: tabId,
        })?.attachmentScopeKey ?? null)
      : null,
  );
  const chatAgentId = useWorkspaceLayoutStore((state) => {
    const layout = workspaceKey ? state.layoutByWorkspace[workspaceKey] : undefined;
    const chat = resolveBrowserAnnotationChat({ serverId, layout, browserTabId: tabId });
    const tab = layout ? collectAllTabs(layout.root).find((c) => c.tabId === chat?.tabId) : null;
    return tab?.target.kind === "agent" ? tab.target.agentId : null;
  });
  const agentTitle = useSessionStore((state) =>
    chatAgentId ? (state.sessions[serverId]?.agents?.get(chatAgentId)?.title ?? null) : null,
  );
  const chatTabCount = useChatTabCount(workspaceKey);

  if (keepsWorkspaceScope || isAttackOwned || !chatScopeKey) {
    return { scopeKey: workspaceScopeKey, chatLabel: null };
  }
  const chatLabel = chatTabCount > 1 ? (agentTitle ?? t("workspace.tabs.actions.newAgent")) : null;
  return { scopeKey: chatScopeKey, chatLabel };
}

/**
 * The draft of the chat an element annotation made now belongs to, read from the stores. Null when
 * it belongs to the workspace scope instead (an Attack run, or Attack mode), where it stays a
 * workspace attachment.
 */
export function resolveBrowserAnnotationDraftKey(
  input: BrowserAnnotationTargetInput,
): string | null {
  const { serverId, workspaceKey, tabId, browserId } = input;
  const state = useWorkspaceLayoutStore.getState();
  const keepsWorkspaceScope = workspaceKey
    ? state.workbenchByWorkspace[workspaceKey]?.mode === "attack"
    : false;
  const isAttackOwned = useBrowserStore.getState().browsersById[browserId]?.owner != null;
  if (keepsWorkspaceScope || isAttackOwned || !workspaceKey) return null;
  const chat = resolveBrowserAnnotationChat({
    serverId,
    layout: state.layoutByWorkspace[workspaceKey],
    browserTabId: tabId,
  });
  return chat?.draftKey ?? null;
}

/** The scope for an annotation being submitted now, read from the stores, not from a render. */
export function resolveBrowserAnnotationScopeKey(
  input: BrowserAnnotationTargetInput,
): string | null {
  const { serverId, workspaceKey, tabId, browserId, workspaceScopeKey } = input;
  const state = useWorkspaceLayoutStore.getState();
  const keepsWorkspaceScope = workspaceKey
    ? state.workbenchByWorkspace[workspaceKey]?.mode === "attack"
    : false;
  const isAttackOwned = useBrowserStore.getState().browsersById[browserId]?.owner != null;
  if (keepsWorkspaceScope || isAttackOwned || !workspaceKey) return workspaceScopeKey;
  const chat = resolveBrowserAnnotationChat({
    serverId,
    layout: state.layoutByWorkspace[workspaceKey],
    browserTabId: tabId,
  });
  return chat?.attachmentScopeKey ?? workspaceScopeKey;
}
