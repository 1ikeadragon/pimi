import { useCallback } from "react";
import { useToast } from "@/contexts/toast-api-context";
import { getDesktopHost } from "@/desktop/host";
import { canSwitchWorkbench, requestEditorWorkbench } from "@/desktop/use-pimi-workbench";
import { revealWorkspaceDirectory } from "@/hooks/use-file-explorer-actions";
import { i18n } from "@/i18n/i18next";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import {
  normalizeWorkspaceDescriptor,
  useSessionStore,
  type WorkspaceDescriptor,
} from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { isAbsolutePath } from "@/utils/path";
import { createWorkspaceFileTabTarget } from "@/workspace/file-open";
import { openExplorerSidebarView } from "@/workspace-tabs/explorer-sidebar";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

export interface IdePathTarget {
  serverId: string;
  /** Absolute path on the host. */
  path: string;
  lineStart?: number;
  lineEnd?: number;
  /** The chat the path came from. It wins a tie with other chats on the same directory. */
  originWorkspaceId?: string | null;
  /**
   * A path no chat holds opens its worktree (or the folder outside git) as a new chat. Without
   * this, the result is "outside" and nothing is created.
   */
  openNewChat?: boolean;
}

export type IdeOpenResult = "opened" | "outside" | "unsaved" | "unreachable";

type IdeClient = NonNullable<
  ReturnType<typeof useSessionStore.getState>["sessions"][string]
>["client"];

/** IDE Mode exists only in the desktop window's split-pane layout. */
export function isIdeModeAvailable(): boolean {
  return canSwitchWorkbench();
}

export function toHostPath(path: string, base: string): string | null {
  if (isAbsolutePath(path)) return trimPath(path);
  // Home-relative paths only the host can expand.
  if (path === "~" || path.startsWith("~/")) return null;
  if (!base || !isAbsolutePath(base)) return null;
  if (path === "." || path === "") return trimPath(base);
  return trimPath(`${trimPath(base)}/${path.replace(/^\.\//, "")}`);
}

/**
 * Opens a host path in IDE Mode, in the chat whose folder holds it: a directory is revealed and
 * selected in Files, a file opens in the editor at its lines. A path no chat holds opens as a
 * new chat only when `openNewChat` asks for it.
 */
export async function openPathInIde(target: IdePathTarget): Promise<IdeOpenResult> {
  const client = useSessionStore.getState().sessions[target.serverId]?.client ?? null;
  if (!client) return "unreachable";
  const path = trimPath(target.path);
  const isFile = target.lineStart !== undefined || !(await isDirectory(client, path));
  const workspace = await resolveWorkspace({
    client,
    target,
    path,
    folder: isFile ? parentPath(path) : path,
  });
  if (workspace === "outside" || workspace === "unreachable") return workspace;

  const workspaceKey = buildWorkspaceTabPersistenceKey({
    serverId: target.serverId,
    workspaceId: workspace.id,
  });
  if (!workspaceKey) return "unreachable";
  if (useWorkspaceLayoutStore.getState().switchWorkbench(workspaceKey, "editor") === "unsaved") {
    return "unsaved";
  }
  // Navigating to another chat follows the previous chat's mode unless IDE Mode is requested
  // for it. The origin chat is already showing and switched above; a request for it would stay
  // pending and apply on a later visit.
  if (workspace.id !== target.originWorkspaceId) requestEditorWorkbench(workspaceKey);
  getDesktopHost()?.dismissPimiWorkspace?.();
  const relative = relativePath(workspace.workspaceDirectory, path);
  if (isFile) {
    navigateToWorkspace({
      serverId: target.serverId,
      workspaceId: workspace.id,
      target: createWorkspaceFileTabTarget({
        path: relative,
        lineStart: target.lineStart,
        lineEnd: target.lineEnd,
      }),
    });
    return "opened";
  }
  navigateToWorkspace({ serverId: target.serverId, workspaceId: workspace.id });
  openExplorerSidebarView({ isCompact: false, workspaceKey, view: "files" });
  await revealWorkspaceDirectory({
    serverId: target.serverId,
    workspaceId: workspace.id,
    workspaceRoot: workspace.workspaceDirectory,
    directoryPath: relative,
  });
  return "opened";
}

// The chat whose folder holds the path, else a new chat on its worktree (or folder) when the
// target asks for one.
async function resolveWorkspace(input: {
  client: NonNullable<IdeClient>;
  target: IdePathTarget;
  path: string;
  folder: string;
}): Promise<WorkspaceDescriptor | "outside" | "unreachable"> {
  const { client, target, path, folder } = input;
  const status = await client.getCheckoutStatus(folder).catch(() => null);
  const worktreeRoot = status?.repoRoot ? trimPath(status.repoRoot) : null;
  const held = findWorkspaceForPath({
    workspaces: useSessionStore.getState().sessions[target.serverId]?.workspaces,
    path,
    worktreeRoot,
    originWorkspaceId: target.originWorkspaceId ?? null,
  });
  if (held) return held;
  if (!target.openNewChat) return "outside";
  return (
    (await openWorkspaceForFolder(client, target.serverId, worktreeRoot ?? folder)) ?? "unreachable"
  );
}

/**
 * Opens a host path in IDE Mode and reports a failure as a toast. A path no chat holds runs
 * `outside` (unless the target opens it as a new chat).
 */
export function useOpenInIde(): (target: IdePathTarget, outside?: () => void) => void {
  const toast = useToast();
  return useCallback(
    (target: IdePathTarget, outside?: () => void) => {
      void openPathInIde(target).then((result) => {
        if (result === "outside") outside?.();
        if (result === "unsaved") toast.show(i18n.t("ideMode.unsavedLayout"));
        if (result === "unreachable") {
          toast.show(i18n.t("ideMode.unreachable", { path: target.path }), { variant: "error" });
        }
        return undefined;
      });
    },
    [toast],
  );
}

/**
 * The chat whose folder holds the path most closely. When the host reports the path's git
 * worktree, only folders inside that worktree count, so a worktree nested in another checkout
 * never opens in the outer one. Among chats on the same folder the origin chat wins, then the
 * most recently used.
 */
function findWorkspaceForPath(input: {
  workspaces: Map<string, WorkspaceDescriptor> | undefined;
  path: string;
  worktreeRoot: string | null;
  originWorkspaceId: string | null;
}): WorkspaceDescriptor | null {
  let best: WorkspaceDescriptor | null = null;
  let bestDepth = -1;
  for (const workspace of input.workspaces?.values() ?? []) {
    if (workspace.background || workspace.archivingAt) continue;
    const directory = trimPath(workspace.workspaceDirectory);
    if (!isPathWithin(input.path, directory)) continue;
    if (input.worktreeRoot && !isPathWithin(directory, input.worktreeRoot)) continue;
    const depth = directory.length;
    if (depth > bestDepth || (depth === bestDepth && best && prefers(workspace, best, input))) {
      best = workspace;
      bestDepth = depth;
    }
  }
  return best;
}

function prefers(
  candidate: WorkspaceDescriptor,
  current: WorkspaceDescriptor,
  input: { originWorkspaceId: string | null },
): boolean {
  if (current.id === input.originWorkspaceId) return false;
  if (candidate.id === input.originWorkspaceId) return true;
  return lastUsed(candidate) > lastUsed(current);
}

function lastUsed(workspace: WorkspaceDescriptor): number {
  return (workspace.lastUserMessageAt ?? workspace.createdAt)?.getTime() ?? 0;
}

async function openWorkspaceForFolder(
  client: NonNullable<IdeClient>,
  serverId: string,
  folder: string,
): Promise<WorkspaceDescriptor | null> {
  const payload = await client.openProject(folder).catch(() => null);
  if (!payload?.workspace) return null;
  const workspace = normalizeWorkspaceDescriptor(payload.workspace);
  useSessionStore.getState().mergeWorkspaces(serverId, [workspace]);
  return workspace;
}

async function isDirectory(client: NonNullable<IdeClient>, path: string): Promise<boolean> {
  try {
    await client.listDirectory(path, ".");
    return true;
  } catch {
    return false;
  }
}

function trimPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

// Windows paths (a drive letter or a UNC share) name the same file in any letter case.
function comparable(path: string): string {
  return /^[A-Za-z]:\//.test(path) || path.startsWith("//") ? path.toLowerCase() : path;
}

function isPathWithin(path: string, folder: string): boolean {
  const target = comparable(path);
  const root = comparable(folder);
  return target === root || target.startsWith(root === "/" ? root : `${root}/`);
}

function parentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash > 0 ? path.slice(0, slash) : "/";
}

function relativePath(folder: string, path: string): string {
  const root = trimPath(folder);
  if (comparable(path) === comparable(root)) return ".";
  return path.slice(root.length + 1);
}
