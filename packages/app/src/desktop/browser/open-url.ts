import { getIsElectron } from "@/constants/platform";
import { isHttpUrl } from "@/utils/http-url";
import { resolveFocusedChatTarget } from "@/composer/focused-chat-target";
import { createWorkspaceBrowser, normalizeWorkspaceBrowserUrl, useBrowserStore } from "./store";
import type { BrowserOwner } from "./store/state";
import { revealWorkspaceTab } from "@/workspace-tabs/navigation";
import { openWorkspaceTargetAtLocation } from "@/workspace-tabs/open-beside";
import {
  collectAllTabs,
  findPaneContainingTab,
  useWorkspaceLayoutStore,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-store";

export interface OpenWorkspaceBrowserUrlInput {
  workspaceKey: string | null;
  /** Undefined opens a blank tab. */
  url: string | undefined;
  parentTabId: string | null;
  location: "main" | "side";
  /** False opens the tab without moving keyboard focus or the focused pane. */
  focus: boolean;
  /** Reveals an existing user-owned tab already on this exact URL instead of opening another. */
  reuse: boolean;
  owner?: BrowserOwner;
}

export interface OpenedWorkspaceBrowser {
  browserId: string;
  tabId: string;
  reused: boolean;
}

function findReusableBrowserTab(layout: WorkspaceLayout | undefined, url: string) {
  if (!layout) return null;
  const wanted = normalizeWorkspaceBrowserUrl(url);
  const browsers = useBrowserStore.getState().browsersById;
  for (const tab of collectAllTabs(layout.root)) {
    if (tab.target.kind !== "browser") continue;
    const record = browsers[tab.target.browserId];
    if (record && record.owner === null && normalizeWorkspaceBrowserUrl(record.url) === wanted) {
      return { tabId: tab.tabId, browserId: record.browserId };
    }
  }
  return null;
}

/** Selects a tab inside its own pane without moving the focused pane or keyboard focus. */
function showTabUnfocused(workspaceKey: string, tabId: string) {
  const store = useWorkspaceLayoutStore.getState();
  const layout = store.layoutByWorkspace[workspaceKey];
  const pane = layout ? findPaneContainingTab(layout.root, tabId) : null;
  if (pane) store.selectTabInPane(workspaceKey, pane.id, tabId);
}

function openUnfocused(input: {
  workspaceKey: string;
  browserId: string;
  parentTabId: string | null;
  location: "main" | "side";
}): string | null {
  const store = useWorkspaceLayoutStore.getState();
  const target = { kind: "browser", browserId: input.browserId } as const;
  const paneId =
    store.layoutMode === "split-panes" && input.location === "side"
      ? store.ensureSidePane(input.workspaceKey, { focus: false })
      : null;
  const tabId = store.openTab({
    workspaceKey: input.workspaceKey,
    target,
    intent: "background",
    placement: paneId ? { mode: "prefer", paneId } : undefined,
    parentTabId: input.parentTabId ?? undefined,
  });
  if (tabId && paneId) showTabUnfocused(input.workspaceKey, tabId);
  return tabId;
}

/**
 * The one way a link click, `/browser`, `/annotate` or the browser_show tool puts a page in front
 * of the user. Returns null when the workspace cannot host a browser tab.
 */
export function openWorkspaceBrowserUrl(
  input: OpenWorkspaceBrowserUrlInput,
): OpenedWorkspaceBrowser | null {
  if (!getIsElectron() || !input.workspaceKey) return null;
  const workspaceKey = input.workspaceKey;
  const store = useWorkspaceLayoutStore.getState();

  if (input.reuse && input.url !== undefined) {
    const existing = findReusableBrowserTab(store.layoutByWorkspace[workspaceKey], input.url);
    if (existing) {
      if (input.focus) revealWorkspaceTab(workspaceKey, existing.tabId);
      else showTabUnfocused(workspaceKey, existing.tabId);
      return { browserId: existing.browserId, tabId: existing.tabId, reused: true };
    }
  }

  const { browserId } = createWorkspaceBrowser({ initialUrl: input.url, owner: input.owner });
  const tabId = input.focus
    ? openWorkspaceTargetAtLocation({
        workspaceKey,
        target: { kind: "browser", browserId },
        location: input.location,
        parentTabId: input.parentTabId,
      })
    : openUnfocused({
        workspaceKey,
        browserId,
        parentTabId: input.parentTabId,
        location: input.location,
      });
  if (!tabId) {
    useBrowserStore.getState().removeBrowser(browserId);
    return null;
  }
  return { browserId, tabId, reused: false };
}

/** The chat tab a page opened from the current layout belongs to. */
export function resolveOriginChatTabId(
  serverId: string,
  layout: WorkspaceLayout | undefined,
): string | null {
  return resolveFocusedChatTarget({ serverId, layout })?.tabId ?? null;
}

/** Runs `/browser [url]` from the chat tab `tabId`: a blank tab, or the URL (reused when open). */
export function openBrowserFromSlashCommand(input: {
  workspaceKey: string | null;
  tabId: string;
  args: string;
  invalidUrlMessage: string;
}): void {
  // The URL parser accepts spaces by encoding them, so "not a url" would open as a host.
  const url = input.args ? normalizeWorkspaceBrowserUrl(input.args) : undefined;
  if (url !== undefined && (/\s/.test(url) || !isHttpUrl(url))) {
    throw new Error(input.invalidUrlMessage);
  }
  openWorkspaceBrowserUrl({
    workspaceKey: input.workspaceKey,
    url,
    parentTabId: input.tabId,
    location: "side",
    focus: true,
    reuse: url !== undefined,
  });
}
