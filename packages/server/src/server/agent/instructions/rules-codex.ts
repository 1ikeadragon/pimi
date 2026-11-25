/**
 * Which files Codex loads as instructions, in load order.
 *
 * COMPAT(codex 0.120.0): follows codex-rs `core/src/project_doc.rs` and `Config::load_instructions`
 * at tag rust-v0.120.0, and was compared with `codex exec` on sentinel files (see the commit
 * message). Not read: `config.toml` tables and `-c` overrides, a project's own `.codex/config.toml`,
 * and the `child_agents_md` feature, which adds a fixed message.
 */
import { dirname, join } from "node:path";
import { readTomlTopLevel } from "./config-parse.js";
import {
  CODEX_PROJECT_DOC_DEFAULT_MAX_BYTES,
  INSTRUCTION_CONFIG_FILE_MAX_BYTES,
  INSTRUCTION_PREVIEW_MAX_BYTES,
  MAX_ANCESTOR_DIRECTORIES,
} from "./limits.js";
import {
  inspectFile,
  readConfigText,
  type FileLayerResult,
  type FileLayerSpec,
  type InstructionContext,
} from "./layer.js";
import type { InstructionLayerReason } from "@pimi/protocol/messages";

const LOCAL_FILENAME = "AGENTS.override.md";
const DEFAULT_FILENAME = "AGENTS.md";
/** Codex's default `project_root_markers` (codex-rs `default_project_root_markers`). */
const DEFAULT_PROJECT_ROOT_MARKERS: readonly string[] = [".git"];

export interface CodexRuleInput {
  /** `CODEX_HOME` or `~/.codex`. */
  codexHome: string;
}

interface CodexConfig {
  maxBytes: number;
  fallbackFilenames: string[];
  rootMarkers: readonly string[];
}

async function readCodexConfig(ctx: InstructionContext, codexHome: string): Promise<CodexConfig> {
  const config: CodexConfig = {
    maxBytes: CODEX_PROJECT_DOC_DEFAULT_MAX_BYTES,
    fallbackFilenames: [],
    rootMarkers: DEFAULT_PROJECT_ROOT_MARKERS,
  };
  const path = join(codexHome, "config.toml");
  const read = await readConfigText(ctx, path, INSTRUCTION_CONFIG_FILE_MAX_BYTES);
  if (!read.ok) {
    ctx.state.notices.push({ code: "config_unreadable", path });
    return config;
  }
  if (read.text === null) return config;
  const values = readTomlTopLevel(read.text);
  const maxBytes = values.get("project_doc_max_bytes");
  if (typeof maxBytes === "number" && maxBytes >= 0) config.maxBytes = maxBytes;
  const fallbacks = values.get("project_doc_fallback_filenames");
  if (Array.isArray(fallbacks)) config.fallbackFilenames = fallbacks;
  const markers = values.get("project_root_markers");
  if (Array.isArray(markers)) config.rootMarkers = markers;
  return config;
}

async function findProjectRoot(
  ctx: InstructionContext,
  start: string,
  markers: readonly string[],
): Promise<string | null> {
  if (markers.length === 0) return null;
  let current = start;
  for (let depth = 0; depth < MAX_ANCESTOR_DIRECTORIES; depth += 1) {
    for (const marker of markers) {
      // A marker counts when it exists as a file or a directory (a worktree's `.git` is a file).
      if ((await ctx.fs.stat(join(current, marker))).ok) return current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  ctx.state.truncated = true;
  return null;
}

function directoriesFromRoot(root: string, cwd: string): string[] {
  const directories: string[] = [];
  let current = cwd;
  for (;;) {
    directories.push(current);
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return directories.toReversed();
}

async function globalLayers(ctx: InstructionContext, codexHome: string): Promise<void> {
  // The first non-empty of AGENTS.override.md, AGENTS.md. Not part of the project budget.
  const override = await inspectFile(
    ctx,
    {
      id: "codex:global:override",
      path: join(codexHome, LOCAL_FILENAME),
      scope: "user",
      skipWhenEmpty: true,
      omitWhenMissing: true,
    },
    INSTRUCTION_PREVIEW_MAX_BYTES,
  );
  await inspectFile(
    ctx,
    {
      id: "codex:global",
      path: join(codexHome, DEFAULT_FILENAME),
      scope: "user",
      skipWhenEmpty: true,
      ...(override?.layer.status === "loaded"
        ? { decided: { status: "skipped" as const, reason: "shadowed_by_override" as const } }
        : {}),
    },
    INSTRUCTION_PREVIEW_MAX_BYTES,
  );
}

/** Codex moves on to the next name when a candidate is absent or not a regular file. */
function isAbsentCandidate(result: FileLayerResult): boolean {
  return (
    result.layer.status === "missing" ||
    result.layer.reason === "not_a_file" ||
    result.layer.reason === "dangling_symlink"
  );
}

/** The first existing candidate in `directory` is the one Codex reads; later names are shadowed. */
async function projectDocInDirectory(
  ctx: InstructionContext,
  config: CodexConfig,
  directory: string,
  atCwd: boolean,
): Promise<FileLayerResult | null | undefined> {
  const names = [LOCAL_FILENAME, DEFAULT_FILENAME];
  for (const fallback of config.fallbackFilenames) {
    if (fallback.length > 0 && !names.includes(fallback)) names.push(fallback);
  }
  let winner: FileLayerResult | undefined;
  let winnerName: string | null = null;
  for (const name of names) {
    const path = join(directory, name);
    let decided: FileLayerSpec["decided"];
    if (config.maxBytes === 0) {
      decided = { status: "skipped", reason: "disabled_by_setting" };
    } else if (winnerName !== null) {
      const reason: InstructionLayerReason =
        winnerName === LOCAL_FILENAME && name === DEFAULT_FILENAME
          ? "shadowed_by_override"
          : "shadowed_by_earlier_file";
      decided = { status: "skipped", reason };
    }
    const result = await inspectFile(
      ctx,
      {
        id: `codex:project:${path}`,
        path,
        scope: atCwd ? "project" : "ancestor",
        // Without a hit the only row worth showing is the cwd's own AGENTS.md.
        omitWhenMissing: !(atCwd && name === DEFAULT_FILENAME),
        ...(decided ? { decided } : {}),
      },
      INSTRUCTION_PREVIEW_MAX_BYTES,
    );
    if (!result) return null;
    if (isAbsentCandidate(result) || winnerName !== null) continue;
    winnerName = name;
    winner = result;
  }
  return winner;
}

/** Files are read root first until `project_doc_max_bytes` is spent; later files are cut. */
function spendBudget(found: readonly FileLayerResult[], maxBytes: number): void {
  if (maxBytes === 0) return;
  let remaining = maxBytes;
  for (const result of found) {
    const { layer } = result;
    if (layer.status !== "loaded") continue;
    const size = layer.sizeBytes ?? 0;
    if (remaining === 0) {
      layer.status = "over_budget";
      layer.reason = "over_budget";
      layer.preview = null;
      layer.previewTruncated = false;
    } else if (result.text.trim().length === 0) {
      layer.status = "skipped";
      layer.reason = "empty";
      layer.preview = null;
    } else if (size > remaining) {
      layer.status = "over_budget";
      layer.reason = "over_budget";
      layer.preview = Buffer.from(layer.preview ?? "")
        .subarray(0, remaining)
        .toString("utf8");
      layer.previewTruncated = true;
      remaining = 0;
    } else {
      remaining -= size;
    }
  }
}

export async function resolveCodexLayers(
  ctx: InstructionContext,
  input: CodexRuleInput,
): Promise<void> {
  const config = await readCodexConfig(ctx, input.codexHome);
  await globalLayers(ctx, input.codexHome);

  const canonicalCwd = await ctx.fs.realpath(ctx.cwd);
  const cwd = canonicalCwd.ok ? canonicalCwd.value : ctx.cwd;
  const root = await findProjectRoot(ctx, cwd, config.rootMarkers);
  const directories = root === null ? [cwd] : directoriesFromRoot(root, cwd);

  const found: FileLayerResult[] = [];
  for (const directory of directories) {
    const result = await projectDocInDirectory(ctx, config, directory, directory === cwd);
    if (result === null) break;
    if (result) found.push(result);
  }
  spendBudget(found, config.maxBytes);
}
