import { expandTilde } from "../utils/path.js";
import type { ProjectRegistry } from "./workspace-registry.js";

export interface WorkspaceSource {
  cwd?: string;
  projectId?: string;
}

export async function resolveWorkspaceSourceCwd(
  source: WorkspaceSource,
  projectRegistry: Pick<ProjectRegistry, "get">,
): Promise<string> {
  if (source.cwd) {
    return expandTilde(source.cwd);
  }
  if (!source.projectId) {
    throw new Error("path or projectId is required to create a chat");
  }

  const project = await projectRegistry.get(source.projectId);
  if (!project || project.archivedAt) {
    throw new Error(`Project not found: ${source.projectId}`);
  }
  return project.rootPath;
}
