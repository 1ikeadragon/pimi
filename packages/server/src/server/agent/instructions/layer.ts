/**
 * Shared state and layer builders for the per-provider rule tables. A rule table decides which
 * paths a provider reads and in what order; this module turns one path into one layer.
 */
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type {
  InstructionLayer,
  InstructionNotice,
  InstructionLayerReason,
  InstructionLayerStatus,
} from "@pimi/protocol/messages";
import type { InstructionFs } from "./fs.js";
import {
  INSTRUCTION_PREVIEW_MAX_BYTES,
  MAX_ANCESTOR_DIRECTORIES,
  MAX_INSTRUCTION_LAYERS,
} from "./limits.js";

export type InstructionScope = InstructionLayer["scope"];

export interface InstructionContext {
  fs: InstructionFs;
  homeDir: string;
  platform: NodeJS.Platform;
  /** The environment the provider process launches with. */
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  /**
   * List a file reached a second time through a symlink as skipped. Off for a provider that
   * loads the same file twice.
   */
  dedupeTargets: boolean;
  /** Epoch ms after which discovery stops and the result is marked truncated. */
  deadlineAt: number;
  now: () => number;
  state: {
    layers: InstructionLayer[];
    truncated: boolean;
    notices: InstructionNotice[];
    /** Real paths already listed, so a symlink to a file listed earlier is not loaded twice. */
    seenRealPaths: Set<string>;
  };
}

export function createContext(
  input: Pick<
    InstructionContext,
    "fs" | "homeDir" | "platform" | "env" | "cwd" | "dedupeTargets"
  > & {
    timeoutMs: number;
    now?: () => number;
  },
): InstructionContext {
  const now = input.now ?? Date.now;
  return {
    fs: input.fs,
    homeDir: input.homeDir,
    platform: input.platform,
    env: input.env,
    cwd: input.cwd,
    dedupeTargets: input.dedupeTargets,
    deadlineAt: now() + input.timeoutMs,
    now,
    state: { layers: [], truncated: false, notices: [], seenRealPaths: new Set() },
  };
}

/** True once discovery must stop; marks the result truncated. */
export function exhausted(ctx: InstructionContext): boolean {
  if (ctx.state.truncated) return true;
  if (ctx.now() > ctx.deadlineAt || ctx.state.layers.length >= MAX_INSTRUCTION_LAYERS) {
    ctx.state.truncated = true;
    return true;
  }
  return false;
}

export function collapseHome(path: string, homeDir: string): string {
  if (path === homeDir) return "~";
  const prefix = homeDir.endsWith(sep) ? homeDir : homeDir + sep;
  return path.startsWith(prefix) ? `~${sep}${path.slice(prefix.length)}` : path;
}

export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export interface FileLayerSpec {
  id: string;
  path: string;
  scope: InstructionScope;
  /** A file larger than this is listed as skipped without being read. */
  providerMaxBytes?: number;
  /** An empty file (after trim) is listed as skipped instead of loaded. */
  skipWhenEmpty?: boolean;
  importedBy?: string | null;
  /** Leave a missing file out of the result; walks above the workspace list only what exists. */
  omitWhenMissing?: boolean;
  /** The rule table already decided this file does not load; report why without reading it. */
  decided?: { status: InstructionLayerStatus; reason: InstructionLayerReason };
}

export interface FileLayerResult {
  layer: InstructionLayer;
  /** The text read for a loaded file, up to `readLimit`; empty otherwise. */
  text: string;
}

function blankLayer(
  ctx: InstructionContext,
  spec: FileLayerSpec,
  status: InstructionLayerStatus,
  reason: InstructionLayerReason | null,
): InstructionLayer {
  return {
    id: spec.id,
    origin: "provider",
    kind: "file",
    scope: spec.scope,
    name: null,
    builtinPart: null,
    path: spec.path,
    displayPath: collapseHome(spec.path, ctx.homeDir),
    status,
    reason,
    importedBy: spec.importedBy ?? null,
    symlinkTarget: null,
    insideWorkspace: isInside(ctx.cwd, spec.path),
    sizeBytes: null,
    preview: null,
    previewTruncated: false,
  };
}

/**
 * Looks at one candidate path and returns its layer. Stats first and reads a bounded head only
 * for files that load. Returns null once the layer cap or the deadline is reached.
 * `readLimit` caps the text returned to the rule table (imports, front matter, budgets).
 */
export async function inspectFile(
  ctx: InstructionContext,
  spec: FileLayerSpec,
  readLimit: number,
): Promise<FileLayerResult | null> {
  if (exhausted(ctx)) return null;
  const finish = (layer: InstructionLayer, text = ""): FileLayerResult => {
    ctx.state.layers.push(layer);
    return { layer, text };
  };

  const info = await ctx.fs.stat(spec.path);
  if (!info.ok) {
    if (info.failure === "missing") {
      const link = await ctx.fs.isSymlink(spec.path);
      if (link.ok && link.value) {
        return finish(blankLayer(ctx, spec, "unreadable", "dangling_symlink"));
      }
      const missing = blankLayer(ctx, spec, "missing", null);
      if (spec.omitWhenMissing) return { layer: missing, text: "" };
      return finish(missing);
    }
    return finish(blankLayer(ctx, spec, "unreadable", "read_failed"));
  }
  const layer = blankLayer(ctx, spec, "loaded", null);
  if (info.value.kind !== "file") {
    layer.status = "unreadable";
    layer.reason = "not_a_file";
    return finish(layer);
  }
  layer.sizeBytes = info.value.size;

  const real = await ctx.fs.realpath(spec.path);
  if (real.ok && real.value !== spec.path) {
    layer.symlinkTarget = real.value;
    layer.insideWorkspace = isInside(ctx.cwd, real.value) && layer.insideWorkspace;
  }
  if (spec.decided) {
    layer.status = spec.decided.status;
    layer.reason = spec.decided.reason;
    return finish(layer);
  }
  if (real.ok && ctx.dedupeTargets) {
    if (ctx.state.seenRealPaths.has(real.value)) {
      layer.status = "skipped";
      layer.reason = "duplicate_target";
      return finish(layer);
    }
    ctx.state.seenRealPaths.add(real.value);
  }
  if (spec.providerMaxBytes !== undefined && info.value.size > spec.providerMaxBytes) {
    layer.status = "skipped";
    layer.reason = "over_provider_size_limit";
    return finish(layer);
  }

  const head = await ctx.fs.readHead(spec.path, Math.max(readLimit, INSTRUCTION_PREVIEW_MAX_BYTES));
  if (!head.ok) {
    layer.status = "unreadable";
    layer.reason = "read_failed";
    return finish(layer);
  }
  const previewBytes = head.value.bytes.subarray(0, INSTRUCTION_PREVIEW_MAX_BYTES);
  layer.preview = new TextDecoder("utf-8").decode(previewBytes, { stream: true });
  layer.previewTruncated = head.value.size > previewBytes.length;
  const text = new TextDecoder("utf-8").decode(head.value.bytes.subarray(0, readLimit), {
    stream: true,
  });
  if (spec.skipWhenEmpty && text.trim().length === 0) {
    layer.status = "skipped";
    layer.reason = "empty";
    layer.preview = null;
    return finish(layer);
  }
  return finish(layer, text);
}

/** Reads a small config file (settings.json, config.toml) without listing it as a layer. */
export async function readConfigText(
  ctx: InstructionContext,
  path: string,
  maxBytes: number,
): Promise<{ ok: true; text: string | null } | { ok: false; message: string }> {
  const head = await ctx.fs.readHead(path, maxBytes);
  if (head.ok) return { ok: true, text: new TextDecoder("utf-8").decode(head.value.bytes) };
  if (head.failure === "missing") return { ok: true, text: null };
  return { ok: false, message: head.message };
}

/** The parent directories of `cwd`, root first, ending with `cwd`. */
export function ancestorDirectories(
  cwd: string,
  limit: number,
): { directories: string[]; capped: boolean } {
  const directories: string[] = [];
  let current = cwd;
  for (;;) {
    directories.push(current);
    const parent = dirname(current);
    if (parent === current) return { directories: directories.toReversed(), capped: false };
    if (directories.length >= limit) return { directories: directories.toReversed(), capped: true };
    current = parent;
  }
}

/** The nearest ancestor (inclusive) holding `.git`, or null. */
export async function findGitRoot(ctx: InstructionContext, start: string): Promise<string | null> {
  let current = start;
  for (let depth = 0; depth < MAX_ANCESTOR_DIRECTORIES; depth += 1) {
    if ((await ctx.fs.stat(join(current, ".git"))).ok) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/** A text cut to the preview limit on a character boundary. */
export function previewText(text: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text);
  if (bytes.length <= INSTRUCTION_PREVIEW_MAX_BYTES) return { text, truncated: false };
  const cut = new TextDecoder("utf-8").decode(bytes.subarray(0, INSTRUCTION_PREVIEW_MAX_BYTES), {
    stream: true,
  });
  return { text: cut, truncated: true };
}

/** A layer for something with no file to read: a URL, an unreadable server path, a mode. */
export function syntheticLayer(
  fields: Pick<InstructionLayer, "id" | "kind" | "scope" | "status"> & Partial<InstructionLayer>,
): InstructionLayer {
  return {
    origin: "provider",
    name: null,
    builtinPart: null,
    path: null,
    displayPath: null,
    reason: null,
    importedBy: null,
    symlinkTarget: null,
    insideWorkspace: false,
    sizeBytes: null,
    preview: null,
    previewTruncated: false,
    ...fields,
  };
}
