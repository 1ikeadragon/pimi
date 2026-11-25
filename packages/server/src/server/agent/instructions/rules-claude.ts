/**
 * Which files Claude Code loads as instructions, in load order.
 *
 * Verified against Claude Code 2.1.331 with sentinel files (see the commit message): ancestor and
 * cwd CLAUDE.md, `.claude/CLAUDE.md`, `CLAUDE.local.md` and `.claude/rules/*.md` load; a rule with
 * a `paths:` front matter does not load at start; AGENTS.md loads only when no CLAUDE.md file
 * exists in the working directory or above; `@path` imports follow four hops, skip code spans, and
 * skip files outside the working directory. Everything else here follows
 * code.claude.com/docs/en/memory and is marked as documented.
 */
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  asRecord,
  asStringArray,
  globToRegExp,
  parseJsonc,
  type ConfigReadResult,
} from "./config-parse.js";
import {
  CLAUDE_AUTO_MEMORY_MAX_BYTES,
  CLAUDE_AUTO_MEMORY_MAX_LINES,
  CLAUDE_IMPORT_MAX_HOPS,
  CLAUDE_INSTRUCTION_FILE_MAX_BYTES,
  INSTRUCTION_CONFIG_FILE_MAX_BYTES,
  MAX_ANCESTOR_DIRECTORIES,
} from "./limits.js";
import {
  ancestorDirectories,
  exhausted,
  inspectFile,
  isInside,
  readConfigText,
  type FileLayerResult,
  type InstructionContext,
  type InstructionScope,
} from "./layer.js";

/** The AGENTS.md policy under `pluginConfigs["cc-plugin-agents-md@builtin"].instructionFiles`. */
export type ClaudeInstructionFilesMode =
  | "claude-md-or-agents-md"
  | "claude-md-and-agents-md"
  | "claude-md"
  | "managed-only";

const INSTRUCTION_FILES_MODES: readonly ClaudeInstructionFilesMode[] = [
  "claude-md-or-agents-md",
  "claude-md-and-agents-md",
  "claude-md",
  "managed-only",
];

const AGENTS_MD_PLUGIN_ID = "cc-plugin-agents-md@builtin";

interface ClaudeUserSettings {
  excludes: RegExp[];
  instructionFiles: ClaudeInstructionFilesMode;
  autoMemoryEnabled: boolean;
  autoMemoryDirectory: string | null;
}

export interface ClaudeRuleInput {
  /** `CLAUDE_CONFIG_DIR` or `~/.claude`, from `claudeConfigDir`. */
  configDir: string;
  /** Where Claude keeps this working directory's auto memory, from `claudeProjectDir`. */
  autoMemoryDirectory: string;
}

function envFlag(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

function managedPolicyPath(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode/CLAUDE.md";
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode\\CLAUDE.md";
  return "/etc/claude-code/CLAUDE.md";
}

async function readUserSettings(
  ctx: InstructionContext,
  configDir: string,
): Promise<ClaudeUserSettings> {
  const settings: ClaudeUserSettings = {
    excludes: [],
    instructionFiles: "claude-md-or-agents-md",
    autoMemoryEnabled: true,
    autoMemoryDirectory: null,
  };
  const path = join(configDir, "settings.json");
  const read = await readConfigText(ctx, path, INSTRUCTION_CONFIG_FILE_MAX_BYTES);
  if (!read.ok) {
    ctx.state.notices.push({ code: "settings_unreadable", path });
    return settings;
  }
  if (read.text === null) return settings;
  const parsed: ConfigReadResult<unknown> = parseJsonc(read.text);
  if (!parsed.ok) {
    ctx.state.notices.push({ code: "settings_unreadable", path });
    return settings;
  }
  const root = asRecord(parsed.value);
  if (!root) return settings;
  const excludes = asStringArray(root.claudeMdExcludes);
  if (excludes) settings.excludes = excludes.map(globToRegExp);
  if (root.autoMemoryEnabled === false) settings.autoMemoryEnabled = false;
  if (typeof root.autoMemoryDirectory === "string") {
    settings.autoMemoryDirectory = root.autoMemoryDirectory;
  }
  const plugin = asRecord(asRecord(root.pluginConfigs)?.[AGENTS_MD_PLUGIN_ID]);
  const mode = asRecord(plugin?.options)?.instructionFiles ?? plugin?.instructionFiles;
  const known = INSTRUCTION_FILES_MODES.find((candidate) => candidate === mode);
  if (known) settings.instructionFiles = known;
  return settings;
}

// ---
// Imports

/** `@path` mentions outside code spans and fenced blocks, in order of appearance. */
export function findClaudeImports(text: string): string[] {
  const withoutFences = text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "");
  const withoutSpans = withoutFences.replace(/`[^`\n]*`/g, "");
  const imports: string[] = [];
  for (const match of withoutSpans.matchAll(/(?<![\w@/.\\-])@([^\s`"'<>()[\]{}]+)/g)) {
    const raw = (match[1] ?? "").replace(/[.,;:!?]+$/, "");
    if (raw.length > 0) imports.push(raw);
  }
  return imports;
}

function resolveImportPath(ctx: InstructionContext, importer: string, raw: string): string {
  if (raw === "~" || raw.startsWith("~/")) return resolve(ctx.homeDir, raw.slice(2));
  return isAbsolute(raw) ? raw : resolve(dirname(importer), raw);
}

interface ImportSource {
  scope: InstructionScope;
  path: string;
  text: string;
  /** Files on the import chain from the memory file to this one, to catch cycles. */
  chain: readonly string[];
  hops: number;
}

async function followImports(ctx: InstructionContext, source: ImportSource): Promise<void> {
  for (const raw of findClaudeImports(source.text)) {
    if (exhausted(ctx)) return;
    const target = resolveImportPath(ctx, source.path, raw);
    // A mention that is not a file (`@someone`) is prose, not an import.
    const info = await ctx.fs.stat(target);
    if (!info.ok || info.value.kind !== "file") continue;
    const id = `claude:import:${target}`;
    const base = { id, path: target, scope: source.scope, importedBy: source.path };
    if (source.chain.includes(target)) {
      await inspectFile(
        ctx,
        { ...base, decided: { status: "skipped", reason: "import_cycle" } },
        0,
      );
      continue;
    }
    if (source.hops >= CLAUDE_IMPORT_MAX_HOPS) {
      await inspectFile(
        ctx,
        { ...base, decided: { status: "skipped", reason: "import_depth_exceeded" } },
        0,
      );
      continue;
    }
    // Claude asks before loading a project file's import from outside the working directory; a
    // user-level file's imports load freely (docs: memory, Imports).
    const external =
      (source.scope === "project" || source.scope === "ancestor" || source.scope === "local") &&
      !isInside(ctx.cwd, target);
    const result = await inspectFile(
      ctx,
      {
        ...base,
        providerMaxBytes: CLAUDE_INSTRUCTION_FILE_MAX_BYTES,
        ...(external ? { decided: { status: "skipped", reason: "needs_import_approval" } } : {}),
      },
      CLAUDE_INSTRUCTION_FILE_MAX_BYTES,
    );
    if (result?.layer.status === "loaded") {
      await followImports(ctx, {
        scope: source.scope,
        path: target,
        text: result.text,
        chain: [...source.chain, target],
        hops: source.hops + 1,
      });
    }
  }
}

// ---
// Files

interface FileOptions {
  id: string;
  path: string;
  scope: InstructionScope;
  omitWhenMissing?: boolean;
}

async function claudeFile(
  ctx: InstructionContext,
  settings: ClaudeUserSettings,
  disabledByEnv: boolean,
  options: FileOptions,
  managed = false,
): Promise<FileLayerResult | null> {
  let decided: { status: "skipped"; reason: "disabled_by_env" | "excluded_by_setting" } | undefined;
  if (disabledByEnv && !managed) decided = { status: "skipped", reason: "disabled_by_env" };
  else if (!managed && settings.excludes.some((pattern) => pattern.test(options.path))) {
    decided = { status: "skipped", reason: "excluded_by_setting" };
  }
  const result = await inspectFile(
    ctx,
    {
      ...options,
      providerMaxBytes: CLAUDE_INSTRUCTION_FILE_MAX_BYTES,
      ...(decided ? { decided } : {}),
    },
    CLAUDE_INSTRUCTION_FILE_MAX_BYTES,
  );
  if (result?.layer.status === "loaded") {
    await followImports(ctx, {
      scope: options.scope,
      path: options.path,
      text: result.text,
      chain: [options.path],
      hops: 0,
    });
  }
  return result;
}

const PATH_FILTER = /^---\r?\n([\s\S]*?)\r?\n---/;

/** A rule whose front matter has `paths:` loads only when Claude reads a matching file. */
export function hasPathFilter(text: string): boolean {
  const frontMatter = PATH_FILTER.exec(text)?.[1];
  return frontMatter !== undefined && /^paths\s*:/m.test(frontMatter);
}

async function claudeRules(
  ctx: InstructionContext,
  settings: ClaudeUserSettings,
  disabledByEnv: boolean,
  directory: string,
  scope: InstructionScope,
  visited: Set<string>,
  omitWhenMissing: boolean,
): Promise<void> {
  if (exhausted(ctx)) return;
  const real = await ctx.fs.realpath(directory);
  const key = real.ok ? real.value : directory;
  if (visited.has(key)) return;
  visited.add(key);
  const entries = await ctx.fs.readDirectory(directory);
  if (!entries.ok) return;
  const sorted = [...entries.value].sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of sorted) {
    const path = join(directory, entry.name);
    if (entry.kind === "directory") {
      await claudeRules(ctx, settings, disabledByEnv, path, scope, visited, omitWhenMissing);
    } else if (entry.name.endsWith(".md")) {
      const result = await claudeFile(ctx, settings, disabledByEnv, {
        id: `claude:rule:${path}`,
        path,
        scope,
        omitWhenMissing,
      });
      if (result && result.layer.status === "loaded" && hasPathFilter(result.text)) {
        result.layer.status = "on_demand";
        result.layer.reason = "has_path_filter";
      }
    }
  }
}

async function autoMemory(
  ctx: InstructionContext,
  settings: ClaudeUserSettings,
  input: ClaudeRuleInput,
): Promise<void> {
  if (!settings.autoMemoryEnabled || envFlag(ctx.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY)) return;
  const directory = settings.autoMemoryDirectory ?? join(input.autoMemoryDirectory, "memory");
  const result = await inspectFile(
    ctx,
    { id: "claude:auto-memory", path: join(directory, "MEMORY.md"), scope: "user" },
    CLAUDE_INSTRUCTION_FILE_MAX_BYTES,
  );
  if (!result || result.layer.status !== "loaded") return;
  // Claude loads the first 200 lines or 25 KB of MEMORY.md; show exactly that.
  const lines = result.text.split("\n");
  const byLines = lines.slice(0, CLAUDE_AUTO_MEMORY_MAX_LINES).join("\n");
  const loaded = Buffer.from(byLines).subarray(0, CLAUDE_AUTO_MEMORY_MAX_BYTES).toString("utf8");
  result.layer.preview = loaded;
  result.layer.previewTruncated = loaded.length < result.text.length;
}

// ---
// Entry

export async function resolveClaudeLayers(
  ctx: InstructionContext,
  input: ClaudeRuleInput,
): Promise<void> {
  const settings = await readUserSettings(ctx, input.configDir);
  const disabledByEnv = envFlag(ctx.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS);
  const managedOnly = settings.instructionFiles === "managed-only";

  await claudeFile(
    ctx,
    settings,
    disabledByEnv,
    { id: "claude:managed", path: managedPolicyPath(ctx.platform), scope: "managed" },
    true,
  );

  const userFile = join(input.configDir, "CLAUDE.md");
  const user = (path: string, id: string, omitWhenMissing = false): FileOptions => ({
    id,
    path,
    scope: "user",
    omitWhenMissing,
  });
  await claudeFileOrManagedOnly(
    ctx,
    settings,
    disabledByEnv,
    managedOnly,
    user(userFile, "claude:user"),
  );
  const userRules = join(input.configDir, "rules");
  if (!managedOnly) {
    await claudeRules(ctx, settings, disabledByEnv, userRules, "user", new Set(), true);
  }

  const { directories, capped } = ancestorDirectories(ctx.cwd, MAX_ANCESTOR_DIRECTORIES);
  if (capped) ctx.state.truncated = true;

  // AGENTS.md loads only where the working directory and its ancestors have no CLAUDE.md file.
  let claudeFamilyExists = false;
  for (const directory of directories) {
    for (const name of ["CLAUDE.md", join(".claude", "CLAUDE.md"), "CLAUDE.local.md"]) {
      const info = await ctx.fs.stat(join(directory, name));
      if (info.ok && info.value.kind === "file") claudeFamilyExists = true;
    }
  }

  const visitedRules = new Set<string>();
  for (const directory of directories) {
    if (exhausted(ctx)) return;
    const atCwd = directory === ctx.cwd;
    const scope: InstructionScope = atCwd ? "project" : "ancestor";
    const omitWhenMissing = !atCwd;
    const candidates: Array<{ path: string; scope: InstructionScope }> = [
      { path: join(directory, "CLAUDE.md"), scope },
      { path: join(directory, ".claude", "CLAUDE.md"), scope },
    ];
    for (const candidate of candidates) {
      if (candidate.path === userFile) continue;
      await claudeFileOrManagedOnly(ctx, settings, disabledByEnv, managedOnly, {
        id: `claude:file:${candidate.path}`,
        path: candidate.path,
        scope: candidate.scope,
        omitWhenMissing,
      });
    }
    if (!managedOnly) {
      await claudeRules(
        ctx,
        settings,
        disabledByEnv,
        join(directory, ".claude", "rules"),
        scope,
        visitedRules,
        true,
      );
    }
    await claudeFileOrManagedOnly(ctx, settings, disabledByEnv, managedOnly, {
      id: `claude:file:${join(directory, "CLAUDE.local.md")}`,
      path: join(directory, "CLAUDE.local.md"),
      scope: "local",
      omitWhenMissing,
    });
    await agentsMd(ctx, settings, disabledByEnv, {
      path: join(directory, "AGENTS.md"),
      scope,
      claudeFamilyExists,
      omitWhenMissing,
    });
  }
  await autoMemory(ctx, settings, input);
}

async function claudeFileOrManagedOnly(
  ctx: InstructionContext,
  settings: ClaudeUserSettings,
  disabledByEnv: boolean,
  managedOnly: boolean,
  options: FileOptions,
): Promise<void> {
  if (!managedOnly) {
    await claudeFile(ctx, settings, disabledByEnv, options);
    return;
  }
  await inspectFile(
    ctx,
    { ...options, decided: { status: "skipped", reason: "disabled_by_setting" } },
    0,
  );
}

async function agentsMd(
  ctx: InstructionContext,
  settings: ClaudeUserSettings,
  disabledByEnv: boolean,
  input: {
    path: string;
    scope: InstructionScope;
    claudeFamilyExists: boolean;
    omitWhenMissing: boolean;
  },
): Promise<void> {
  const base = {
    id: `claude:agents:${input.path}`,
    path: input.path,
    scope: input.scope,
    omitWhenMissing: input.omitWhenMissing,
  };
  const mode = settings.instructionFiles;
  if (mode === "managed-only" || mode === "claude-md") {
    await inspectFile(
      ctx,
      { ...base, decided: { status: "skipped", reason: "disabled_by_setting" } },
      0,
    );
    return;
  }
  if (mode === "claude-md-or-agents-md" && input.claudeFamilyExists) {
    await inspectFile(
      ctx,
      { ...base, decided: { status: "skipped", reason: "claude_md_present" } },
      0,
    );
    return;
  }
  await claudeFile(ctx, settings, disabledByEnv, base);
}
