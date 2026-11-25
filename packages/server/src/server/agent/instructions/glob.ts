/**
 * Expands the glob patterns a provider's config lists as instruction files (OpenCode's
 * `instructions`). Reads only directories along the pattern, through the injected fs.
 */
import { join, sep } from "node:path";
import { globToRegExp, hasGlobMagic } from "./config-parse.js";
import { exhausted, type InstructionContext } from "./layer.js";
import { MAX_INSTRUCTION_LAYERS } from "./limits.js";

/** Files under `baseDirectory` matching `pattern` (`/`-separated, relative), sorted. */
export async function expandGlob(
  ctx: InstructionContext,
  baseDirectory: string,
  pattern: string,
): Promise<string[]> {
  const segments = pattern
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part.length > 0);
  const matches: string[] = [];
  await walk(ctx, baseDirectory, segments, matches);
  return matches.sort();
}

async function walk(
  ctx: InstructionContext,
  directory: string,
  segments: readonly string[],
  matches: string[],
): Promise<void> {
  if (exhausted(ctx) || matches.length >= MAX_INSTRUCTION_LAYERS) return;
  const [head, ...rest] = segments;
  if (head === undefined) return;
  if (!hasGlobMagic(head)) {
    const path = join(directory, head);
    if (rest.length === 0) {
      const info = await ctx.fs.stat(path);
      if (info.ok && info.value.kind === "file") matches.push(path);
      return;
    }
    await walk(ctx, path, rest, matches);
    return;
  }
  const entries = await ctx.fs.readDirectory(directory);
  if (!entries.ok) return;
  if (head === "**") {
    // `**` matches zero or more directories.
    await walk(ctx, directory, rest, matches);
    for (const entry of entries.value) {
      if (entry.kind === "directory")
        await walk(ctx, join(directory, entry.name), segments, matches);
    }
    return;
  }
  const matcher = globToRegExp(head);
  for (const entry of entries.value) {
    if (!matcher.test(entry.name)) continue;
    const path = `${directory}${directory.endsWith(sep) ? "" : sep}${entry.name}`;
    if (rest.length === 0) {
      if (entry.kind === "file") matches.push(path);
    } else if (entry.kind === "directory") {
      await walk(ctx, path, rest, matches);
    }
  }
}
