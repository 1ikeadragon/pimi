import { getIsElectron } from "@/constants/platform";
import { isHttpUrl } from "@/utils/http-url";
import { resolveFocusedChatTarget } from "@/composer/focused-chat-target";
import { createWorkspaceBrowser, normalizeWorkspaceBrowserUrl, useBrowserStore } from "./store";
import type { BrowserOwner } from "./store/state";
import { revealWorkspaceTab } from "@/workspace-tabs/navigation";
import { openWorkspaceTargetAtLocation } from "@/workspace-tabs/open-beside";
import {
  collectAllPanes,
  collectAllTabs,
  findPaneById,
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

/** The browser tab to annotate with no URL given: the focused one, else one already on screen. */
function findShownBrowserTab(layout: WorkspaceLayout | undefined) {
  if (!layout) return null;
  const tabs = collectAllTabs(layout.root);
  const focusedPane = findPaneById(layout.root, layout.focusedPaneId);
  const shownTabIds = [
    focusedPane?.focusedTabId,
    ...collectAllPanes(layout.root).map((pane) => pane.focusedTabId),
  ];
  for (const tabId of shownTabIds) {
    const tab = tabs.find((candidate) => candidate.tabId === tabId);
    if (tab?.target.kind === "browser")
      return { tabId: tab.tabId, browserId: tab.target.browserId };
  }
  return null;
}

/**
 * Runs `/browser [url]` and `/annotate [url]` from a chat tab, and the palette's Annotate web page.
 * With a URL it opens or reuses a tab on it; `annotate` then arms the element selector once the
 * page has loaded. Annotate with no URL arms the browser tab already on screen, and opens a blank
 * tab like `/browser` when there is none.
 */
export function openBrowserFromSlashCommand(input: {
  workspaceKey: string | null;
  tabId: string | null;
  args: string;
  annotate: boolean;
  invalidUrlMessage: string;
}): void {
  // The URL parser accepts spaces by encoding them, so "not a url" would open as a host.
  const url = input.args ? normalizeWorkspaceBrowserUrl(input.args) : undefined;
  if (url !== undefined && (/\s/.test(url) || !isHttpUrl(url))) {
    throw new Error(input.invalidUrlMessage);
  }
  if (url === undefined && input.annotate && input.workspaceKey) {
    const shown = findShownBrowserTab(
      useWorkspaceLayoutStore.getState().layoutByWorkspace[input.workspaceKey],
    );
    if (shown) {
      revealWorkspaceTab(input.workspaceKey, shown.tabId);
      useBrowserStore.getState().requestAnnotate(shown.browserId);
      return;
    }
  }
  const opened = openWorkspaceBrowserUrl({
    workspaceKey: input.workspaceKey,
    url,
    parentTabId: input.tabId,
    location: "side",
    focus: true,
    reuse: url !== undefined,
  });
  if (opened && input.annotate && url !== undefined) {
    useBrowserStore.getState().requestAnnotate(opened.browserId);
  }
}
