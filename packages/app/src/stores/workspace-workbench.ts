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

export type WorkbenchMode = "agent" | "editor" | "attack";
export interface WorkbenchPreset {
  layout: WorkspaceLayout;
  explorerPaneId: string | null;
  sidePaneId: string | null;
}
export interface WorkspaceWorkbench {
  mode: WorkbenchMode;
  /** The layouts of the modes that are not showing. Only the showing layout owns open tabs. */
  alternates: Partial<Record<WorkbenchMode, WorkbenchPreset>>;
}

// Attack mode places tabs by kind into four fixed panes: the control pane on the left (with the
// lead agent's chat), browsers and terminals in the centre, findings on the right.
export const ATTACK_CONTROL_PANE_ID = "attack-control";
export const ATTACK_BROWSER_PANE_ID = "attack-browsers";
export const ATTACK_TERMINAL_PANE_ID = "attack-terminals";
export const ATTACK_FINDINGS_PANE_ID = "attack-findings";

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

function paneNode(
  id: string,
  tabs: WorkspaceTab[],
  focus?: string | null,
  hidden?: boolean,
): SplitNode {
  return {
    kind: "pane",
    pane: paneWithTabs({ id, tabIds: [], focusedTabId: null, hidden }, tabs, focus),
  };
}

export function isWorkbenchChatTarget(target: WorkspaceTab["target"]) {
  return target.kind === "agent" || target.kind === "draft" || target.kind === "provider_subagent";
}

export function isWorkbenchDocument(target: WorkspaceTab["target"]) {
  return (
    target.kind === "file" ||
    target.kind === "working_diff" ||
    target.kind === "commit_diff" ||
    target.kind === "chat_visual"
  );
}

function isChat(tab: WorkspaceTab) {
  return isWorkbenchChatTarget(tab.target);
}

export function attackPaneIdForTarget(target: WorkspaceTab["target"]): string {
  if (target.kind === "attack_findings") return ATTACK_FINDINGS_PANE_ID;
  if (target.kind === "terminal") return ATTACK_TERMINAL_PANE_ID;
  if (target.kind === "browser") return ATTACK_BROWSER_PANE_ID;
  if (target.kind === "attack_control" || isWorkbenchChatTarget(target)) {
    return ATTACK_CONTROL_PANE_ID;
  }
  return ATTACK_BROWSER_PANE_ID;
}

function attackTab(target: "attack_control" | "attack_findings"): WorkspaceTab {
  return { ...createNewWorkspaceTab(), target: { kind: target } };
}

export function createAttackWorkbench(current: WorkbenchPreset): WorkbenchPreset {
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
  const existing = collectAllTabs(current.layout.root).filter(
    (tab) => !explorer.tabIds.includes(tab.tabId),
  );
  const focused = findPaneById(current.layout.root, current.layout.focusedPaneId)?.focusedTabId;
  const withTarget = (paneId: string) =>
    existing.filter((tab) => attackPaneIdForTarget(tab.target) === paneId);
  const chats = withTarget(ATTACK_CONTROL_PANE_ID);
  const control = attackTab("attack_control");
  const hiddenExplorer: SplitNode = {
    kind: "pane",
    pane: paneWithTabs({ ...explorer, hidden: true }, sidebarTabs),
  };
  const center: SplitNode = {
    kind: "group",
    group: {
      id: "attack-center",
      direction: "vertical",
      children: [
        paneNode(ATTACK_BROWSER_PANE_ID, withTarget(ATTACK_BROWSER_PANE_ID), focused),
        paneNode(ATTACK_TERMINAL_PANE_ID, withTarget(ATTACK_TERMINAL_PANE_ID), focused),
      ],
      sizes: [0.62, 0.38],
    },
  };
  const workbench: SplitNode = {
    kind: "group",
    group: {
      id: "attack-workbench",
      direction: "horizontal",
      children: [
        paneNode(ATTACK_CONTROL_PANE_ID, [control, ...chats], control.tabId),
        center,
        paneNode(ATTACK_FINDINGS_PANE_ID, [attackTab("attack_findings")]),
      ],
      sizes: [0.24, 0.5, 0.26],
    },
  };
  return {
    explorerPaneId: explorer.id,
    sidePaneId: null,
    layout: normalizeLayout({
      root: {
        kind: "group",
        group: {
          id: "attack-root",
          direction: "horizontal",
          children: [hiddenExplorer, workbench],
          sizes: [0.01, 0.99],
        },
      },
      focusedPaneId: ATTACK_CONTROL_PANE_ID,
      parentTabIdByTabId: current.layout.parentTabIdByTabId,
    }),
  };
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
  const emptyChat = chats.length === 0;
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
      children: [center, paneNode(sidePaneId, chats, focusedChat?.tabId, emptyChat || undefined)],
      sizes: [0.72, 0.28],
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
  const panes = collectAllPanes(template.layout.root, true);
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
    if (mode === "attack") {
      const paneId = attackPaneIdForTarget(tab.target);
      if (panes.some((pane) => pane.id === paneId)) return paneId;
    }
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
    const added = additions.get(node.pane.id) ?? [];
    const revealChat = mode === "editor" && node.pane.id === sidePaneId && added.some(isChat);
    return {
      kind: "pane",
      pane: paneWithTabs(revealChat ? { ...node.pane, hidden: undefined } : node.pane, [
        ...previous,
        ...added,
      ]),
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
