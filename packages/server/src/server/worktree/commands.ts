import { basename } from "node:path";

import { isPimiOwnedWorktreeCwd } from "../../utils/worktree.js";
import {
  archiveByScope,
  resolveWorkspaceIdAtPath,
  type ArchiveDependencies,
  type ArchiveScope,
} from "../workspace-archive-service.js";
import type {
  CreatePimiWorktreeInput,
  CreatePimiWorktreeResult,
} from "../pimi-worktree-service.js";
import { toWorktreeWireError, type WorktreeWireError } from "../worktree-errors.js";
import type { WorkspaceGitService, WorkspaceGitWorktreeInfo } from "../workspace-git-service.js";

export interface ListPimiWorktreesCommandDependencies {
  workspaceGitService: Pick<WorkspaceGitService, "listWorktrees">;
}

export interface ListPimiWorktreesCommandInput {
  cwd: string;
  reason?: string;
}

export async function listPimiWorktreesCommand(
  dependencies: ListPimiWorktreesCommandDependencies,
  input: ListPimiWorktreesCommandInput,
): Promise<WorkspaceGitWorktreeInfo[]> {
  if (input.reason) {
    return dependencies.workspaceGitService.listWorktrees(input.cwd, { reason: input.reason });
  }
  return dependencies.workspaceGitService.listWorktrees(input.cwd);
}

type CreatePimiWorktreeWorkflow<Result extends CreatePimiWorktreeResult> = (
  input: CreatePimiWorktreeInput,
) => Promise<Result>;

export interface CreatePimiWorktreeCommandDependencies<
  Result extends CreatePimiWorktreeResult = CreatePimiWorktreeResult,
> {
  pimiHome?: string;
  worktreesRoot?: string;
  createPimiWorktreeWorkflow?: CreatePimiWorktreeWorkflow<Result>;
}

export type CreatePimiWorktreeCommandInput = Omit<CreatePimiWorktreeInput, "pimiHome"> & {
  pimiHome?: string;
  worktreesRoot?: string;
};

export type CreatePimiWorktreeCommandResult<Result extends CreatePimiWorktreeResult> =
  | {
      ok: true;
      createdWorktree: Result;
    }
  | {
      ok: false;
      error: WorktreeWireError;
      cause: unknown;
    };

export async function createPimiWorktreeCommand<Result extends CreatePimiWorktreeResult>(
  dependencies: CreatePimiWorktreeCommandDependencies<Result>,
  input: CreatePimiWorktreeCommandInput,
): Promise<CreatePimiWorktreeCommandResult<Result>> {
  try {
    if (!dependencies.createPimiWorktreeWorkflow) {
      throw new Error("Pimi worktree service is not configured");
    }

    const createdWorktree = await dependencies.createPimiWorktreeWorkflow({
      ...input,

      pimiHome: input.pimiHome ?? dependencies.pimiHome,
      worktreesRoot: input.worktreesRoot ?? dependencies.worktreesRoot,
    });
    return { ok: true, createdWorktree };
  } catch (error) {
    return {
      ok: false,
      error: toWorktreeWireError(error),
      cause: error,
    };
  }
}

export interface ArchiveCommandDependencies extends Omit<
  ArchiveDependencies,
  "workspaceGitService"
> {
  workspaceGitService: Pick<
    WorkspaceGitService,
    "getSnapshot" | "listWorktrees" | "invalidateWorktrees"
  >;
}

export interface ArchiveCommandInput {
  requestId: string;
  repoRoot?: string | null;
  worktreePath?: string;
  worktreeSlug?: string;
  branchName?: string;
  workspaceId?: string;
  scope?: ArchiveScope["kind"];
}

export type ArchiveCommandResult =
  | {
      ok: true;
      removedAgents: string[];
    }
  | {
      ok: false;
      code: "NOT_ALLOWED";
      message: string;
      removedAgents: [];
    };

export async function archiveCommand(
  dependencies: ArchiveCommandDependencies,
  input: ArchiveCommandInput,
): Promise<ArchiveCommandResult> {
  const targetPath = await resolveArchiveTarget(dependencies, input);
  const scope = input.scope ?? "workspace";
  const ownership = await isPimiOwnedWorktreeCwd(targetPath, {
    pimiHome: dependencies.pimiHome,
    worktreesRoot: dependencies.pimiWorktreesBaseRoot,
  });

  if (scope === "worktree") {
    if (!ownership.allowed) {
      return {
        ok: false,
        code: "NOT_ALLOWED",
        message: "Worktree is not a Pimi-owned worktree",
        removedAgents: [],
      };
    }

    const result = await archiveByScope(dependencies, {
      scope: { kind: "worktree", targetPath },
      requestId: input.requestId,
    });

    return {
      ok: true,
      removedAgents: result.archivedAgentIds,
    };
  }

  const workspaceId =
    input.workspaceId ?? (await resolveWorkspaceIdAtPath(dependencies, targetPath));

  if (!workspaceId) {
    dependencies.sessionLogger?.warn(
      { targetPath },
      "Could not resolve workspace for archive; skipping",
    );
    return {
      ok: true,
      removedAgents: [],
    };
  }

  const result = await archiveByScope(dependencies, {
    scope: { kind: "workspace", workspaceId },
    requestId: input.requestId,
  });

  return {
    ok: true,
    removedAgents: result.archivedAgentIds,
  };
}

async function resolveArchiveTarget(
  dependencies: ArchiveCommandDependencies,
  input: ArchiveCommandInput,
): Promise<string> {
  const repoRoot = input.repoRoot ?? null;
  if (input.worktreePath) {
    return input.worktreePath;
  }

  if (input.worktreeSlug) {
    if (!repoRoot) {
      throw new Error("repoRoot is required when worktreeSlug is supplied");
    }
    return resolveWorktreeSlugPath(dependencies, repoRoot, input.worktreeSlug);
  }

  if (repoRoot && input.branchName) {
    const worktrees = await dependencies.workspaceGitService.listWorktrees(repoRoot);
    const match = worktrees.find((entry) => entry.branchName === input.branchName);
    if (!match) {
      throw new Error(`Pimi worktree not found for branch ${input.branchName}`);
    }
    return match.path;
  }

  throw new Error("worktreePath, worktreeSlug, or repoRoot+branchName is required");
}

async function resolveWorktreeSlugPath(
  dependencies: ArchiveCommandDependencies,
  repoRoot: string,
  worktreeSlug: string,
): Promise<string> {
  // Worktrees can live anywhere (legacy root or wherever
  // a plugin placed them), so a slug resolves against the
  // discovered worktree list for the repo, never a guessed path.
  const worktrees = await dependencies.workspaceGitService.listWorktrees(repoRoot);
  const match = worktrees.find((entry) => basename(entry.path) === worktreeSlug);
  if (!match) {
    const found = worktrees.map((entry) => basename(entry.path));
    throw new Error(
      found.length > 0
        ? `Pimi worktree not found for slug ${worktreeSlug}: found ${found.join(", ")}`
        : `Pimi worktree not found for slug ${worktreeSlug}`,
    );
  }
  return match.path;
}
