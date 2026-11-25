/**
 * Which files GitHub Copilot CLI reads as instructions.
 *
 * COMPAT(copilot): from docs.github.com's Copilot CLI custom-instructions page; the CLI was not
 * run here. Copilot documents no precedence between these files, so the list is in discovery
 * order, not priority order. An `.instructions.md` file whose front matter has `applyTo:` is
 * listed as on-demand, since it applies only to matching files.
 */
import { join } from "node:path";
import {
  ancestorDirectories,
  exhausted,
  findGitRoot,
  inspectFile,
  type InstructionContext,
  type InstructionScope,
} from "./layer.js";
import { INSTRUCTION_PREVIEW_MAX_BYTES, MAX_ANCESTOR_DIRECTORIES } from "./limits.js";

export interface CopilotRuleInput {
  /** `COPILOT_HOME` or `~/.copilot`. */
  copilotHome: string;
}

const DIRECTORY_FILES = ["AGENTS.md", "CLAUDE.md", join(".claude", "CLAUDE.md"), "GEMINI.md"];

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

function hasApplyTo(text: string): boolean {
  const frontMatter = FRONT_MATTER.exec(text)?.[1];
  return frontMatter !== undefined && /^applyTo\s*:/m.test(frontMatter);
}

async function instructionsDirectory(
  ctx: InstructionContext,
  directory: string,
  scope: InstructionScope,
): Promise<void> {
  if (exhausted(ctx)) return;
  const entries = await ctx.fs.readDirectory(directory);
  if (!entries.ok) return;
  const sorted = [...entries.value].sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of sorted) {
    const path = join(directory, entry.name);
    if (entry.kind === "directory") {
      await instructionsDirectory(ctx, path, scope);
    } else if (entry.name.endsWith(".instructions.md")) {
      const result = await inspectFile(
        ctx,
        { id: `copilot:instructions:${path}`, path, scope },
        INSTRUCTION_PREVIEW_MAX_BYTES,
      );
      if (result?.layer.status === "loaded" && hasApplyTo(result.text)) {
        result.layer.status = "on_demand";
        result.layer.reason = "has_path_filter";
      }
    }
  }
}

export async function resolveCopilotLayers(
  ctx: InstructionContext,
  input: CopilotRuleInput,
): Promise<void> {
  await inspectFile(
    ctx,
    {
      id: "copilot:user",
      path: join(input.copilotHome, "copilot-instructions.md"),
      scope: "user",
    },
    0,
  );
  await instructionsDirectory(ctx, join(input.copilotHome, "instructions"), "user");

  const gitRoot = await findGitRoot(ctx, ctx.cwd);
  const { directories } = ancestorDirectories(ctx.cwd, MAX_ANCESTOR_DIRECTORIES);
  const repoDirectories =
    gitRoot === null ? [ctx.cwd] : directories.slice(directories.indexOf(gitRoot));
  const root = repoDirectories[0] ?? ctx.cwd;

  await inspectFile(
    ctx,
    {
      id: "copilot:repo",
      path: join(root, ".github", "copilot-instructions.md"),
      scope: root === ctx.cwd ? "project" : "ancestor",
    },
    0,
  );
  await instructionsDirectory(ctx, join(root, ".github", "instructions"), "project");

  for (const directory of repoDirectories) {
    const atCwd = directory === ctx.cwd;
    for (const name of DIRECTORY_FILES) {
      await inspectFile(
        ctx,
        {
          id: `copilot:file:${join(directory, name)}`,
          path: join(directory, name),
          scope: atCwd ? "project" : "ancestor",
          omitWhenMissing: !atCwd || name !== "AGENTS.md",
        },
        0,
      );
    }
  }
}
