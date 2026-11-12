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

// Attack mode shows two panes: the board in the centre and the findings on the right. Agent,
// browser and terminal tabs stay alive in a hidden holding pane; the board reads them from there.
export const ATTACK_BOARD_PANE_ID = "attack-board";
export const ATTACK_HOLDING_PANE_ID = "attack-holding";
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
  if (target.kind === "attack_board") return ATTACK_BOARD_PANE_ID;
  return ATTACK_HOLDING_PANE_ID;
}

function attackTab(target: "attack_board" | "attack_findings"): WorkspaceTab {
  return { ...createNewWorkspaceTab(), target: { kind: target } };
}

// The tab each attack pane must always hold: its panel, or the holding pane's launcher.
const ATTACK_PANE_FIXTURES: Record<string, "attack_board" | "attack_findings" | "new_tab"> = {
  [ATTACK_BOARD_PANE_ID]: "attack_board",
  [ATTACK_FINDINGS_PANE_ID]: "attack_findings",
  [ATTACK_HOLDING_PANE_ID]: "new_tab",
};

// The board, the findings list and the holding pane's launcher exist only in Attack mode. They are
// left behind when another mode takes the tabs, and made again on the way back.
function attackOnlyTabIds(layout: WorkspaceLayout): Set<string> {
  const holding = findPaneById(layout.root, ATTACK_HOLDING_PANE_ID);
  return new Set(
    collectAllTabs(layout.root)
      .filter(
        (tab) =>
          tab.target.kind === "attack_board" ||
          tab.target.kind === "attack_findings" ||
          (tab.target.kind === "new_tab" && holding?.tabIds.includes(tab.tabId)),
      )
      .map((tab) => tab.tabId),
  );
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
  const board = attackTab("attack_board");
  // The launcher keeps the holding pane alive after its last real tab closes (an empty pane is
  // removed, and the next browser tab would land in the board). It also stays the focused tab, so no
  // chat or browser panel mounts in the zero-size pane: a mounted browser panel there would hold its
  // webview unpainted and break screenshots, while a parked one stays paintable.
  const launcher = existing.find((tab) => tab.target.kind === "new_tab") ?? createNewWorkspaceTab();
  const holding = existing.includes(launcher) ? existing : [...existing, launcher];
  const hiddenExplorer: SplitNode = {
    kind: "pane",
    pane: paneWithTabs({ ...explorer, hidden: true }, sidebarTabs),
  };
  const workbench: SplitNode = {
    kind: "group",
    group: {
      id: "attack-workbench",
      direction: "horizontal",
      children: [
        paneNode(ATTACK_BOARD_PANE_ID, [board], board.tabId),
        paneNode(ATTACK_FINDINGS_PANE_ID, [attackTab("attack_findings")]),
      ],
      sizes: [0.74, 0.26],
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
          children: [
            hiddenExplorer,
            paneNode(ATTACK_HOLDING_PANE_ID, holding, launcher.tabId, true),
            workbench,
          ],
          sizes: [0.005, 0.005, 0.99],
        },
      },
      focusedPaneId: ATTACK_BOARD_PANE_ID,
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
  const attackOnly = attackOnlyTabIds(current.layout);
  const all = collectAllTabs(current.layout.root).filter(
    (tab) => !explorer.tabIds.includes(tab.tabId) && !attackOnly.has(tab.tabId),
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
  const leftBehind = mode === "attack" ? new Set<string>() : attackOnlyTabIds(live);
  const newTabs = tabs.filter((tab) => !placed.has(tab.tabId) && !leftBehind.has(tab.tabId));
  const destination = (tab: WorkspaceTab) => {
    if (
      tab.target.kind === "files" ||
      tab.target.kind === "search" ||
      tab.target.kind === "changes_tree"
    )
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
    const paneTabs = [...previous, ...added];
    const fixture = mode === "attack" ? ATTACK_PANE_FIXTURES[node.pane.id] : undefined;
    let focusedTabId = node.pane.focusedTabId;
    if (fixture) {
      let fixed = paneTabs.find((tab) => tab.target.kind === fixture);
      if (!fixed) {
        fixed = fixture === "new_tab" ? createNewWorkspaceTab() : attackTab(fixture);
        paneTabs.push(fixed);
      }
      // The launcher stays focused so no chat or browser panel mounts in the zero-size pane.
      focusedTabId = fixed.tabId;
    }
    return {
      kind: "pane",
      pane: paneWithTabs(
        revealChat ? { ...node.pane, hidden: undefined } : node.pane,
        paneTabs,
        focusedTabId,
      ),
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
