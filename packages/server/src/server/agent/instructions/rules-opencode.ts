/**
 * Which files OpenCode loads as instructions, in load order.
 *
 * COMPAT(opencode 1.x): `packages/opencode/src/session/instruction.ts` at tag v1.14.46. The
 * first project filename (AGENTS.md, CLAUDE.md, CONTEXT.md) with any match between the working
 * directory and the worktree root wins, and every match of that name loads, nearest first.
 *
 * COMPAT(opencode 2.x): `packages/core/src/config/plugin/instruction.ts` and
 * `instruction-discovery.ts` on the dev branch. AGENTS.md and CLAUDE.md are looked up in every
 * directory from the working directory up to home (or the project root outside home); a CLAUDE.md
 * is dropped where the same directory has an AGENTS.md.
 *
 * Neither version was run here (no OpenCode binary on this machine); both tables come from
 * reading that source.
 */
import { dirname, isAbsolute, join, parse } from "node:path";
import { asRecord, asStringArray, parseJsonc } from "./config-parse.js";
import { expandGlob } from "./glob.js";
import { INSTRUCTION_CONFIG_FILE_MAX_BYTES, MAX_ANCESTOR_DIRECTORIES } from "./limits.js";
import {
  ancestorDirectories,
  collapseHome,
  exhausted,
  findGitRoot,
  inspectFile,
  isInside,
  readConfigText,
  syntheticLayer,
  type InstructionContext,
  type InstructionScope,
} from "./layer.js";

export interface OpenCodeRuleInput {
  major: 1 | 2;
  /** OpenCode's own config directory (`$XDG_CONFIG_HOME/opencode`), where global AGENTS.md lives. */
  configHome: string;
  /** The session runs on an OpenCode server Pimi did not start; its global files are unknown. */
  externalServer: boolean;
  /** The OpenCode mode (agent) the chat uses, or null. */
  agentName: string | null;
}

const V1_FILENAMES = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"] as const;
const CONFIG_FILENAMES = ["opencode.json", "opencode.jsonc"] as const;
const PROJECT_CONFIG_DIRECTORY = ".opencode";

function envFlag(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

function isUrl(value: string): boolean {
  return /^https?:\/\//.test(value);
}

/** The directories from `start` up to and including `stop`, nearest first. */
function directoriesUpTo(start: string, stop: string): string[] {
  const { directories } = ancestorDirectories(start, MAX_ANCESTOR_DIRECTORIES);
  const upward = [...directories].toReversed();
  const index = upward.indexOf(stop);
  return index === -1 ? [start] : upward.slice(0, index + 1);
}

// ---
// opencode.json `instructions`

async function configInstructions(
  ctx: InstructionContext,
  input: OpenCodeRuleInput,
  directories: readonly string[],
  projectConfig: boolean,
): Promise<string[]> {
  const candidates: string[] = [];
  for (const name of CONFIG_FILENAMES) candidates.push(join(input.configHome, name));
  const explicit = ctx.env.OPENCODE_CONFIG;
  if (explicit) candidates.push(explicit);
  if (projectConfig) {
    for (const directory of [...directories].toReversed()) {
      for (const name of CONFIG_FILENAMES) {
        candidates.push(join(directory, name));
        candidates.push(join(directory, PROJECT_CONFIG_DIRECTORY, name));
      }
    }
  }
  const entries: string[] = [];
  for (const path of candidates) {
    const read = await readConfigText(ctx, path, INSTRUCTION_CONFIG_FILE_MAX_BYTES);
    if (!read.ok) {
      ctx.state.notices.push({ code: "config_unreadable", path });
      continue;
    }
    if (read.text === null) continue;
    const parsed = parseJsonc(read.text);
    if (!parsed.ok) {
      ctx.state.notices.push({ code: "config_unreadable", path });
      continue;
    }
    const list = asStringArray(asRecord(parsed.value)?.instructions);
    if (list) entries.push(...list);
  }
  return [...new Set(entries)];
}

async function configuredLayers(
  ctx: InstructionContext,
  entries: readonly string[],
  searchDirectories: readonly string[],
  projectRoot: string,
): Promise<void> {
  for (const raw of entries) {
    if (exhausted(ctx)) return;
    if (isUrl(raw)) {
      // Remote entries are fetched by OpenCode; Pimi never fetches them.
      ctx.state.layers.push(
        syntheticLayer({
          id: `opencode:url:${raw}`,
          kind: "remote_url",
          scope: "project",
          path: raw,
          displayPath: raw,
          status: "unknown",
          reason: "not_fetched",
        }),
      );
      continue;
    }
    const expanded = raw.startsWith("~/") ? join(ctx.homeDir, raw.slice(2)) : raw;
    const matches: string[] = [];
    if (isAbsolute(expanded)) {
      const directory = dirname(expanded);
      const name = expanded.slice(directory.length + 1);
      matches.push(...(await expandGlob(ctx, directory, name)));
    } else {
      for (const directory of searchDirectories) {
        matches.push(...(await expandGlob(ctx, directory, expanded)));
      }
    }
    if (matches.length === 0) {
      // No file matched: list the entry as written, since no real path exists to show.
      ctx.state.layers.push(
        syntheticLayer({
          id: `opencode:instructions:${raw}`,
          kind: "file",
          scope: "project",
          displayPath: raw,
          status: "missing",
        }),
      );
      continue;
    }
    for (const path of matches) {
      const scope: InstructionScope = isInside(projectRoot, path) ? "project" : "user";
      await inspectFile(
        ctx,
        { id: `opencode:instructions:${path}`, path, scope },
        INSTRUCTION_CONFIG_FILE_MAX_BYTES,
      );
    }
  }
}

// ---
// Global file

async function globalLayers(
  ctx: InstructionContext,
  input: OpenCodeRuleInput,
  claudeFallback: boolean,
): Promise<void> {
  const files = [
    { id: "opencode:global", path: join(input.configHome, "AGENTS.md") },
    ...(claudeFallback
      ? [{ id: "opencode:global-claude", path: join(ctx.homeDir, ".claude", "CLAUDE.md") }]
      : []),
  ];
  if (input.externalServer) {
    // A server Pimi did not start reads its own home and config directory, not necessarily ours.
    for (const file of files) {
      ctx.state.layers.push(
        syntheticLayer({
          id: file.id,
          kind: "file",
          scope: "user",
          path: file.path,
          displayPath: collapseHome(file.path, ctx.homeDir),
          status: "unknown",
          reason: "external_server",
        }),
      );
    }
    return;
  }
  // The first global file that exists wins; the rest are shadowed.
  let winner: string | null = null;
  for (const file of files) {
    const result = await inspectFile(
      ctx,
      {
        ...file,
        scope: "user",
        ...(winner
          ? { decided: { status: "skipped" as const, reason: "shadowed_by_earlier_file" as const } }
          : {}),
      },
      0,
    );
    if (!result) return;
    if (winner === null && result.layer.status === "loaded") winner = file.path;
  }
}

// ---
// Agent (mode) definition

async function agentDefinition(
  ctx: InstructionContext,
  input: OpenCodeRuleInput,
  directories: readonly string[],
): Promise<void> {
  if (!input.agentName) return;
  const name = input.agentName;
  const roots = [
    ...directories.map((directory) => join(directory, PROJECT_CONFIG_DIRECTORY)),
    input.configHome,
  ];
  for (const root of roots) {
    for (const folder of ["agents", "agent"]) {
      const path = join(root, folder, `${name}.md`);
      const info = await ctx.fs.stat(path);
      if (!info.ok || info.value.kind !== "file") continue;
      const result = await inspectFile(
        ctx,
        { id: `opencode:agent:${path}`, path, scope: isInside(ctx.cwd, path) ? "project" : "user" },
        0,
      );
      if (result) {
        result.layer.kind = "agent_definition";
        result.layer.name = name;
      }
      return;
    }
  }
  // Built-in agents and agents defined in opencode.json have no file to show.
  ctx.state.layers.push(
    syntheticLayer({
      id: `opencode:agent:${name}`,
      kind: "agent_definition",
      scope: "project",
      name,
      status: "unknown",
      reason: "not_read_by_pimi",
    }),
  );
}

// ---
// Entry

/** v1: the first filename with any match between the cwd and the worktree root wins. */
async function v1ProjectFiles(
  ctx: InstructionContext,
  directories: readonly string[],
  names: readonly string[],
): Promise<void> {
  let winnerName: string | null = null;
  for (const name of names) {
    const hits: string[] = [];
    for (const directory of directories) {
      const path = join(directory, name);
      const info = await ctx.fs.stat(path);
      if (info.ok && info.value.kind === "file") hits.push(path);
    }
    const isWinner = winnerName === null && hits.length > 0;
    if (isWinner) winnerName = name;
    for (const path of hits) {
      await inspectFile(
        ctx,
        {
          id: `opencode:project:${path}`,
          path,
          scope: path === join(ctx.cwd, name) ? "project" : "ancestor",
          ...(isWinner
            ? {}
            : {
                decided: {
                  status: "skipped" as const,
                  reason: "shadowed_by_earlier_file" as const,
                },
              }),
        },
        0,
      );
    }
    if (name === "AGENTS.md" && hits.length === 0) {
      const path = join(ctx.cwd, name);
      await inspectFile(ctx, { id: `opencode:project:${path}`, path, scope: "project" }, 0);
    }
  }
}

/** v2: every directory contributes AGENTS.md, or CLAUDE.md where it has none. */
async function v2ProjectFiles(
  ctx: InstructionContext,
  directories: readonly string[],
  claude: boolean,
): Promise<void> {
  for (const directory of directories) {
    const scope = directory === ctx.cwd ? "project" : "ancestor";
    const agents = join(directory, "AGENTS.md");
    const agentsResult = await inspectFile(
      ctx,
      {
        id: `opencode:project:${agents}`,
        path: agents,
        scope,
        omitWhenMissing: directory !== ctx.cwd,
      },
      0,
    );
    if (!claude) continue;
    const claudePath = join(directory, "CLAUDE.md");
    const shadowed = agentsResult?.layer.status !== "missing";
    await inspectFile(
      ctx,
      {
        id: `opencode:project:${claudePath}`,
        path: claudePath,
        scope,
        omitWhenMissing: true,
        ...(shadowed
          ? { decided: { status: "skipped" as const, reason: "shadowed_by_agents_md" as const } }
          : {}),
      },
      0,
    );
  }
}

export async function resolveOpenCodeLayers(
  ctx: InstructionContext,
  input: OpenCodeRuleInput,
): Promise<void> {
  const claude = !envFlag(ctx.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT);
  const disableProject = envFlag(ctx.env.OPENCODE_DISABLE_PROJECT_CONFIG);
  const gitRoot = await findGitRoot(ctx, ctx.cwd);
  const projectRoot = gitRoot ?? ctx.cwd;

  await globalLayers(ctx, input, claude);

  // COMPAT(opencode 1.x): a directory outside a git repository has the filesystem root as its
  // worktree, so the v1 walk reaches the top. Assumed from reading the source, not run.
  // COMPAT(opencode 2.x): the walk stops at home when the cwd is under it, else at the project root.
  let stop = projectRoot;
  if (input.major === 1) stop = gitRoot ?? parse(ctx.cwd).root;
  else if (isInside(ctx.homeDir, ctx.cwd)) stop = ctx.homeDir;
  const searchDirectories = directoriesUpTo(ctx.cwd, stop);

  if (!disableProject) {
    if (input.major === 1) {
      await v1ProjectFiles(
        ctx,
        searchDirectories,
        claude ? V1_FILENAMES : ["AGENTS.md", "CONTEXT.md"],
      );
    } else {
      await v2ProjectFiles(ctx, searchDirectories, claude);
    }
  }

  const entries = await configInstructions(ctx, input, searchDirectories, !disableProject);
  await configuredLayers(
    ctx,
    entries,
    disableProject ? [input.configHome] : searchDirectories,
    projectRoot,
  );
  await agentDefinition(ctx, input, searchDirectories);
}
