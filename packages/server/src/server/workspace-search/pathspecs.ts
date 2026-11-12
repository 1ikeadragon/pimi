import path from "node:path";

/** A comma-separated "files to include" field turns into one glob per entry. */
export function splitGlobList(text: string): string[] {
  return text
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Expands one glob the way the Search fields document it. A glob with no slash matches at any
 * depth and a glob with a slash is anchored at the workspace root; each also matches everything
 * inside a folder it names. Throws when the glob would leave the workspace.
 */
function expandGlob(raw: string): string[] {
  let glob = raw.trim().replace(/\\/g, "/");
  const anchored = glob.startsWith("/");
  glob = glob
    .replace(/^(\.\/)+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (glob.length === 0) return [];
  if (path.posix.isAbsolute(glob) || /^[A-Za-z]:/.test(glob) || glob.split("/").includes("..")) {
    throw new Error(`"${raw}" points outside the workspace.`);
  }
  const rooted = anchored || glob.includes("/") ? glob : `**/${glob}`;
  return [rooted, `${rooted}/**`];
}

/**
 * Git pathspecs for the include and exclude lists. Every pathspec is written here with its magic
 * prefix, so user text is only ever a glob after `:(glob)` and cannot add `:(top)` or any other magic.
 */
export function buildPathspecs(include: readonly string[], exclude: readonly string[]): string[] {
  const included = include.flatMap(expandGlob).map((glob) => `:(glob)${glob}`);
  const excluded = exclude.flatMap(expandGlob).map((glob) => `:(exclude,glob)${glob}`);
  // Git needs one positive pathspec; "." is the workspace root, so exclusions alone mean "all but".
  return [...(included.length > 0 ? included : ["."]), ...excluded];
}

/** A result path from git, or null when it is absolute or climbs out of the workspace. */
export function toWorkspaceRelativePath(reported: string): string | null {
  const normalized = reported.replace(/\\/g, "/");
  if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) return null;
  if (normalized.split("/").includes("..")) return null;
  return normalized;
}
