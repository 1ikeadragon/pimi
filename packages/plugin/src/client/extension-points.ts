import type { ComponentType, ReactNode } from "react";

/**
 * Named places in Pimi's UI a plugin can replace, wrap, or add to. Each entry maps a point id
 * to the props its component receives. Props are plain data plus callbacks; the host maps its
 * internal props into these before calling plugin code, so core refactors do not leak through.
 *
 * Adding a point: wrap the component's definition with `overridable(id, Component, adapter)` in
 * the app, then add its id and props here in the same commit. See `docs/extension-points.md`.
 */
export interface PluginComponentPoints {
  /** The whole app frame: sidebar, routes, overlays. Ignores overrides in safe mode. */
  "shell.root": {};

  "screen.sessions": {};
  "screen.settings": { section: string | null };
  "screen.review": { serverId: string | null };
  "screen.newWorkspace": {
    serverId: string;
    projectId: string | null;
    sourceDirectory: string | null;
  };
  "screen.automations": {};
  "screen.usage": {};
  "screen.tasks": { serverId: string | null; taskId: string | null };
  "screen.library": { section: "skills" | "hooks" };

  "sidebar.root": { active: boolean; desktopOverlay: boolean };
  "sidebar.workspaceRow": {
    serverId: string;
    workspaceId: string;
    name: string;
    title: string | null;
    directory: string;
    branch: string | null;
    hovered: boolean;
    /** The row's default children: status, name, trailing actions. */
    children: ReactNode;
  };
  "sidebar.footer": {};

  /** One page of the Settings screen, looked up by section slug. */
  "settings.section": { slug: string };

  "chat.userMessage": {
    message: string;
    attachments: readonly PluginMessageAttachment[];
    timestamp: number;
    pending: boolean;
    agentId: string | null;
    serverId: string | null;
  };
  "chat.assistantMessage": {
    markdown: string;
    phase: "streaming" | "complete";
    timestamp: number;
    serverId: string | null;
  };
  "chat.toolCall": {
    toolName: string;
    status: "executing" | "running" | "completed" | "failed" | "canceled";
    args: unknown;
    result: unknown;
    error: unknown;
    agentId: string | null;
    serverId: string | null;
  };
  "chat.todoList": { items: readonly { text: string; completed: boolean }[] };
  "chat.notification": { level: "info" | "warning" | "error"; message: string };
  /** The scrolling message list of one agent. */
  "chat.timeline": { agentId: string; serverId: string };
  "composer.root": { serverId: string; agentId: string | null; workspaceId: string | null };

  "diff.surface": { serverId: string; workspaceId: string | null };
  "diff.document": { kind: "working" | "commit"; fileCount: number; focusPath: string | null };
  "files.tree": { serverId: string; workspaceId: string | null };
  "files.treeRow": { path: string; kind: "file" | "directory"; depth: number; expanded: boolean };
  /** One open file tab. `workspaceRoot` is the workspace directory. */
  "files.viewer": { serverId: string; workspaceRoot: string; path: string };
  "search.view": { serverId: string; workspaceId: string };
  "commandCenter.root": {};
}

export interface PluginMessageAttachment {
  readonly type: string;
  readonly name: string | null;
}

export type PluginComponentPointId = keyof PluginComponentPoints;

/** Props a replacement component receives: the point's props plus the next layer in. */
export type PluginComponentOverrideProps<Id extends PluginComponentPointId> =
  PluginComponentPoints[Id] & {
    /**
     * The next layer inward: other plugins' replacement, else Pimi's own component. Render it
     * to keep the original behavior; pass a partial to change props it receives.
     */
    Original: ComponentType<Partial<PluginComponentPoints[Id]>>;
  };

export interface PluginComponentWrapperProps<Id extends PluginComponentPointId> {
  /** The props the point renders with. */
  props: PluginComponentPoints[Id];
  /** The inner chain rendered with `props`. */
  children: ReactNode;
  /** The inner chain, for rendering with changed props instead of `children`. */
  Original: ComponentType<Partial<PluginComponentPoints[Id]>>;
}

export interface PluginExtensionOptions {
  /** Lower runs first; wrappers nest in ascending order, the lowest outermost. Default 0. */
  order?: number;
}

/** Places a plugin can append UI to, in order, without replacing anything. */
export interface PluginSlots {
  /** Rendered above the app's own overlays and dialogs. */
  "shell.overlays": {};
  /** Rows listed in the Settings sidebar beneath the built-in sections. */
  "settings.sidebar": { compact: boolean };
  /** Rendered above the composer in a chat. */
  "chat.beforeComposer": { serverId: string; agentId: string };
  /** Rendered after the workspace list in the left sidebar. */
  "sidebar.belowWorkspaces": { compact: boolean };
  /** Trailing content on a file tree row. */
  "fileTree.rowTrailing": { path: string; kind: "file" | "directory"; hovered: boolean };
}

export type PluginSlotId = keyof PluginSlots;

export interface PluginSlotItem<Id extends PluginSlotId> {
  id: string;
  order?: number;
  Component: ComponentType<PluginSlots[Id]>;
}

/** Menus a plugin can add items to, with the context each item receives. */
export interface PluginMenus {
  "file-tree-row": {
    serverId: string;
    workspaceId: string;
    path: string;
    kind: "file" | "directory";
  };
  "sidebar-workspace-row": {
    serverId: string;
    workspaceId: string;
    directory: string;
    name: string;
  };
  "chat-message": { serverId: string; agentId: string; role: "user" | "assistant"; text: string };
}

export type PluginMenuId = keyof PluginMenus;

export interface PluginMenuItemContribution<Id extends PluginMenuId, Text = string> {
  menu: Id;
  id: string;
  title: Text;
  /** A Lucide icon name. */
  icon?: string;
  /** Hide the item for this context. */
  when?(context: PluginMenus[Id]): boolean;
  run(context: PluginMenus[Id]): void | Promise<void>;
}
