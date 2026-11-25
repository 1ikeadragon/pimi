/**
 * Which files Pi loads as context files, in load order.
 *
 * COMPAT(pi): `loadProjectContextFiles` in `packages/coding-agent/src/core/resource-loader.ts` of
 * earendil-works/pi (main when read; not pinned to a release). The agent directory comes first,
 * then every directory from the filesystem root down to the working directory. Each directory
 * contributes the first of AGENTS.override.md, AGENTS.md, AGENTS.MD, CLAUDE.md, CLAUDE.MD that is
 * a regular file. Pi also drops the main repository's file when a nested linked worktree has its
 * own; that case is not modeled here, so such a file may be listed as loaded when Pi skips it.
 */
import { join } from "node:path";
import { MAX_ANCESTOR_DIRECTORIES } from "./limits.js";
import {
  ancestorDirectories,
  inspectFile,
  type InstructionContext,
  type InstructionScope,
} from "./layer.js";

export interface PiRuleInput {
  /** `PI_CODING_AGENT_DIR` or `~/.pi/agent`, from `resolvePiAgentDir`. */
  agentDirectory: string;
}

const CANDIDATE_NAMES = [
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
] as const;

async function contextFileFromDirectory(
  ctx: InstructionContext,
  directory: string,
  scope: InstructionScope,
  idPrefix: string,
  showMissingAgentsMd: boolean,
): Promise<void> {
  let winner: string | null = null;
  // A case-insensitive filesystem answers `AGENTS.MD` for `AGENTS.md`; only exact spellings count.
  const listing = await ctx.fs.readDirectory(directory);
  const spelled = listing.ok ? new Set(listing.value.map((entry) => entry.name)) : null;
  for (const name of CANDIDATE_NAMES) {
    if (spelled && !spelled.has(name) && !(showMissingAgentsMd && name === "AGENTS.md")) continue;
    const path = join(directory, name);
    const result = await inspectFile(
      ctx,
      {
        id: `${idPrefix}:${path}`,
        path,
        scope,
        omitWhenMissing: !(showMissingAgentsMd && name === "AGENTS.md"),
        ...(winner
          ? { decided: { status: "skipped" as const, reason: "shadowed_by_earlier_file" as const } }
          : {}),
      },
      0,
    );
    if (!result) return;
    const absent =
      result.layer.status === "missing" ||
      result.layer.reason === "not_a_file" ||
      result.layer.reason === "dangling_symlink";
    if (!absent && winner === null) winner = name;
  }
}

export async function resolvePiLayers(ctx: InstructionContext, input: PiRuleInput): Promise<void> {
  await contextFileFromDirectory(ctx, input.agentDirectory, "user", "pi:global", false);
  const { directories, capped } = ancestorDirectories(ctx.cwd, MAX_ANCESTOR_DIRECTORIES);
  if (capped) ctx.state.truncated = true;
  for (const directory of directories) {
    const atCwd = directory === ctx.cwd;
    await contextFileFromDirectory(ctx, directory, atCwd ? "project" : "ancestor", "pi:dir", atCwd);
  }
}
