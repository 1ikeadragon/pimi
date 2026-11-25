import { useMemo } from "react";
import type { NestedChangesRepository, NestedFileState } from "@pimi/protocol/messages";
import { useNestedChanges } from "@/git/use-nested-changes";

/** What the file tree shows on a row: a state letter on a changed file, a dot above one. */
export type TreeChangeMark = { kind: "file"; state: NestedFileState } | { kind: "directory" };

export type TreeChangeMarks = ReadonlyMap<string, TreeChangeMark>;

const NO_MARKS: TreeChangeMarks = new Map();

/** `root` from the workspace directory, `/`-separated; null when it is not inside it. */
function pathFromWorkspace(workspaceRoot: string, root: string): string | null {
  const base = workspaceRoot.replace(/\\/g, "/").replace(/\/$/, "");
  const target = root.replace(/\\/g, "/");
  if (target === base) return "";
  return target.startsWith(`${base}/`) ? target.slice(base.length + 1) : null;
}

/**
 * Tree marks keyed by the explorer's workspace-relative paths. A path changed in both the index and
 * the working tree shows its working-tree state, the one a further edit would start from.
 */
export function buildTreeChangeMarks(
  repositories: readonly NestedChangesRepository[],
  workspaceRoot: string,
): TreeChangeMarks {
  const marks = new Map<string, TreeChangeMark>();
  for (const repository of repositories) {
    const prefix = pathFromWorkspace(workspaceRoot, repository.root);
    if (prefix === null) continue;
    const staged = repository.files.filter((file) => file.staged);
    // Staged entries first so a working-tree entry for the same path overwrites them.
    const ordered = [...staged, ...repository.files.filter((file) => !file.staged)];
    for (const file of ordered) {
      const path = prefix ? `${prefix}/${file.path}` : file.path;
      marks.set(path, { kind: "file", state: file.state });
      const segments = path.split("/").slice(0, -1);
      for (let depth = 1; depth <= segments.length; depth += 1) {
        const directory = segments.slice(0, depth).join("/");
        if (!marks.has(directory)) marks.set(directory, { kind: "directory" });
      }
    }
  }
  return marks;
}

/** Marks for the file tree of `workspaceRoot`, from the same subscription Changes uses. */
export function useTreeChangeMarks(input: {
  serverId: string;
  workspaceRoot: string;
  enabled: boolean;
}): TreeChangeMarks {
  const { state } = useNestedChanges({
    serverId: input.serverId,
    cwd: input.workspaceRoot,
    enabled: input.enabled,
  });
  const repositories = state.status === "idle" ? null : state.repositories;
  return useMemo(
    () => (repositories ? buildTreeChangeMarks(repositories, input.workspaceRoot) : NO_MARKS),
    [repositories, input.workspaceRoot],
  );
}
