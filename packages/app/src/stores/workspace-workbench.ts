import {
  collectAllPanes,
  collectAllTabs,
  createWorkspaceLayoutWithExplorerSidebar,
  DEFAULT_PANE_ID,
  EXPLORER_SIDEBAR_PANE_ID,
  findPaneById,
  normalizeLayout,
  type SplitNode,
  type SplitPane,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-actions";
import type { WorkspaceLayoutIdSource } from "@/stores/workspace-layout-ids";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import { createNewWorkspaceTab } from "@/workspace-tabs/new-tab";

export type WorkbenchMode = "agent" | "editor";
export interface WorkbenchPreset {
  layout: WorkspaceLayout;
  explorerPaneId: string | null;
  sidePaneId: string | null;
}
export interface WorkspaceWorkbench {
  mode: WorkbenchMode;
  alternate: WorkbenchPreset;
}

function paneWithTabs(pane: SplitPane, tabs: WorkspaceTab[], focusedTabId = pane.focusedTabId) {
  const tabIds = tabs.map((tab) => tab.tabId);
  return {
    ...pane,
    tabs,
    tabIds,
    focusedTabId:
      focusedTabId && tabIds.includes(focusedTabId) ? focusedTabId : (tabIds[0] ?? null),
  };
}

function paneNode(id: string, tabs: WorkspaceTab[], focus?: string | null): SplitNode {
  return { kind: "pane", pane: paneWithTabs({ id, tabIds: [], focusedTabId: null }, tabs, focus) };
}

export function isWorkbenchChatTarget(target: WorkspaceTab["target"]) {
  return target.kind === "agent" || target.kind === "draft" || target.kind === "provider_subagent";
}

export function isWorkbenchDocument(target: WorkspaceTab["target"]) {
  return target.kind === "file" || target.kind === "working_diff" || target.kind === "commit_diff";
}

function isChat(tab: WorkspaceTab) {
  return isWorkbenchChatTarget(tab.target);
}

export function createEditorWorkbench(
  current: WorkbenchPreset,
  ids: WorkspaceLayoutIdSource,
): WorkbenchPreset {
  const fallback = createWorkspaceLayoutWithExplorerSidebar();
  const explorerPaneId = current.explorerPaneId ?? EXPLORER_SIDEBAR_PANE_ID;
  const explorer =
    findPaneById(current.layout.root, explorerPaneId) ??
    findPaneById(fallback.root, EXPLORER_SIDEBAR_PANE_ID);
  if (!explorer) throw new Error("Workspace Explorer is unavailable.");
  const explorerTabs = collectAllTabs(current.layout.root).filter((tab) =>
    explorer.tabIds.includes(tab.tabId),
  );
  const sidebarTabs = explorerTabs.length
    ? explorerTabs
    : collectAllTabs(fallback.root).filter(
        (tab) => tab.target.kind === "files" || tab.target.kind === "changes_tree",
      );
  const filesTab = sidebarTabs.find((tab) => tab.target.kind === "files")?.tabId;
  const files: SplitNode = {
    kind: "pane",
    pane: paneWithTabs({ ...explorer, hidden: false }, sidebarTabs, filesTab),
  };
  const all = collectAllTabs(current.layout.root).filter(
    (tab) => !explorer.tabIds.includes(tab.tabId),
  );
  const focused = findPaneById(current.layout.root, current.layout.focusedPaneId)?.focusedTabId;
  const chats = all.filter(isChat);
  const chatLauncher = chats.length ? undefined : all.find((tab) => tab.target.kind === "new_tab");
  if (chats.length === 0) chats.push(chatLauncher ?? createNewWorkspaceTab());
  const visibleTabs = new Set(
    collectAllPanes(current.layout.root)
      .filter((pane) => !pane.hidden)
      .map((pane) => pane.focusedTabId),
  );
  const focusedChat =
    chats.find(({ tabId }) => tabId === focused) ??
    chats.find(({ tabId }) => visibleTabs.has(tabId));
  const terminals = all.filter((tab) => tab.target.kind === "terminal");
  const editorTabs = all.filter(
    (tab) => tab !== chatLauncher && !isChat(tab) && tab.target.kind !== "terminal",
  );
  const activeFile =
    editorTabs.find((tab) => tab.tabId === focused && tab.target.kind === "file") ??
    editorTabs.find((tab) => tab.target.kind === "file");
  const sidePaneId = ids.createNodeId("pane");
  const editor = paneNode(DEFAULT_PANE_ID, editorTabs, activeFile?.tabId);
  const center: SplitNode = terminals.length
    ? {
        kind: "group",
        group: {
          id: ids.createNodeId("group"),
          direction: "vertical",
          children: [editor, paneNode(ids.createNodeId("pane"), terminals)],
          sizes: [0.72, 0.28],
        },
      }
    : editor;
  const workbench: SplitNode = {
    kind: "group",
    group: {
      id: ids.createNodeId("group"),
      direction: "horizontal",
      children: [center, paneNode(sidePaneId, chats, focusedChat?.tabId)],
      sizes: [0.66, 0.34],
    },
  };
  return {
    explorerPaneId: explorer.id,
    sidePaneId,
    layout: normalizeLayout({
      root: {
        kind: "group",
        group: {
          id: ids.createNodeId("group"),
          direction: "horizontal",
          children: [files, workbench],
          sizes: [0.21, 0.79],
        },
      },
      focusedPaneId: DEFAULT_PANE_ID,
      parentTabIdByTabId: current.layout.parentTabIdByTabId,
    }),
  };
}

/** The inactive layout is a placement template. Only the current layout owns open tabs. */
export function restoreWorkbench(
  template: WorkbenchPreset,
  live: WorkspaceLayout,
  mode: WorkbenchMode,
): WorkbenchPreset {
  const tabs = collectAllTabs(live.root);
  const byId = new Map(tabs.map((tab) => [tab.tabId, tab]));
  const panes = collectAllPanes(template.layout.root);
  const placed = new Set(panes.flatMap((pane) => pane.tabIds));
  const explorerPaneId = panes.find((pane) => pane.id === template.explorerPaneId)?.id ?? null;
  const sidePaneId = panes.find((pane) => pane.id === template.sidePaneId)?.id ?? null;
  const ordinary = panes.filter((pane) => pane.id !== template.explorerPaneId && !pane.hidden);
  const main = ordinary.find((pane) => pane.id === DEFAULT_PANE_ID) ?? ordinary[0] ?? panes[0];
  const newTabs = tabs.filter((tab) => !placed.has(tab.tabId));
  const destination = (tab: WorkspaceTab) => {
    if (tab.target.kind === "files" || tab.target.kind === "changes_tree")
      return explorerPaneId ?? main?.id;
    if (mode === "editor" && isChat(tab) && sidePaneId) return sidePaneId;
    return main?.id;
  };
  const additions = new Map<string, WorkspaceTab[]>();
  for (const tab of newTabs) {
    const paneId = destination(tab);
    if (!paneId) continue;
    const existing = additions.get(paneId);
    if (existing) existing.push(tab);
    else additions.set(paneId, [tab]);
  }
  const merge = (node: SplitNode): SplitNode => {
    if (node.kind === "group")
      return { kind: "group", group: { ...node.group, children: node.group.children.map(merge) } };
    const previous = node.pane.tabIds.flatMap((id) => {
      const tab = byId.get(id);
      return tab ? [tab] : [];
    });
    return {
      kind: "pane",
      pane: paneWithTabs(node.pane, [...previous, ...(additions.get(node.pane.id) ?? [])]),
    };
  };
  return {
    explorerPaneId,
    sidePaneId,
    layout: normalizeLayout({
      ...template.layout,
      root: merge(template.layout.root),
      parentTabIdByTabId: live.parentTabIdByTabId,
    }),
  };
}
