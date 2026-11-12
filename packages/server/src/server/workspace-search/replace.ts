import path from "node:path";
import type {
  WorkspaceSearchReplaceFileResult,
  WorkspaceSearchReplaceRequest,
} from "@pimi/protocol/workspace-search";
import { WORKSPACE_SEARCH_LIMITS } from "@pimi/protocol/workspace-search";
import {
  createWorkspaceSearchRegExp,
  expandReplacement,
} from "@pimi/protocol/search/workspace-search-pattern";
import {
  getExplorerFileVersion,
  readExplorerFileBytes,
  writeExplorerFile,
} from "../file-explorer/service.js";
import { describeSearchQueryProblem } from "./search.js";
import { toWorkspaceRelativePath } from "./pathspecs.js";

type ReplaceFile = WorkspaceSearchReplaceRequest["files"][number];

const LINE_BREAK = /(\r?\n)/;

function skipped(filePath: string, reason: string): WorkspaceSearchReplaceFileResult {
  return { path: filePath, replacements: 0, skippedReason: reason };
}

/**
 * Rewrites `text` one line at a time, the unit `git grep` matched in, and numbers lines the way
 * git does so a dismissed match (line, column) lands on the same occurrence the search showed.
 */
function replaceInText(
  text: string,
  regex: RegExp,
  request: WorkspaceSearchReplaceRequest,
  dismissed: ReadonlySet<string>,
): { text: string; found: number; replaced: number } {
  const parts = text.split(LINE_BREAK);
  let found = 0;
  let replaced = 0;
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index];
    const lineNumber = index / 2 + 1;
    let rebuilt = "";
    let cursor = 0;
    regex.lastIndex = 0;
    for (let match = regex.exec(line); match !== null; match = regex.exec(line)) {
      if (match[0].length === 0) {
        regex.lastIndex += 1;
        continue;
      }
      found += 1;
      if (dismissed.has(`${lineNumber}:${match.index}`)) continue;
      rebuilt +=
        line.slice(cursor, match.index) +
        expandReplacement(match, request.replacement, request.isRegex);
      cursor = match.index + match[0].length;
      replaced += 1;
    }
    if (cursor > 0) parts[index] = rebuilt + line.slice(cursor);
  }
  return { text: parts.join(""), found, replaced };
}

async function replaceInFile(
  root: string,
  file: ReplaceFile,
  regex: RegExp,
  request: WorkspaceSearchReplaceRequest,
): Promise<WorkspaceSearchReplaceFileResult> {
  const relativePath = toWorkspaceRelativePath(file.path);
  if (relativePath === null) return skipped(file.path, "Outside the workspace.");
  try {
    const version = await getExplorerFileVersion({ root, relativePath });
    if (version.status !== "ready") return skipped(file.path, "The file is gone.");
    if (version.size > WORKSPACE_SEARCH_LIMITS.maxReplaceFileBytes) {
      return skipped(file.path, "Larger than the 1 MB the editor can write.");
    }
    const bytes = await readExplorerFileBytes({ root, relativePath });
    if (bytes.kind !== "text") return skipped(file.path, "Not a text file.");
    const dismissed = new Set(file.skip.map((entry) => `${entry.line}:${entry.column}`));
    const edited = replaceInText(
      Buffer.from(bytes.bytes).toString("utf8"),
      regex,
      request,
      dismissed,
    );
    if (edited.found !== file.expectedMatches) {
      return skipped(file.path, "The file changed after the search. Search again.");
    }
    if (edited.replaced === 0) return skipped(file.path, "Every match was dismissed.");
    const written = await writeExplorerFile({
      root,
      relativePath,
      content: edited.text,
      expectedModifiedAt: bytes.modifiedAt,
      expectedRevision: bytes.revision,
    });
    if (written.status === "conflict") {
      return skipped(file.path, "The file changed while replacing. Search again.");
    }
    if (written.status === "error") return skipped(file.path, written.error);
    return { path: file.path, replacements: edited.replaced, skippedReason: null };
  } catch (error) {
    return skipped(file.path, error instanceof Error ? error.message : String(error));
  }
}

export interface ReplaceOutcome {
  error: string | null;
  filesChanged: number;
  replacements: number;
}

/**
 * Applies the replacement to the listed files, in order, reporting each as it finishes. File
 * access goes through the editor's write path: it confines every path to the workspace root,
 * refuses symlinks that leave it, and writes only if the file is unchanged since it was read.
 */
export async function replaceInFiles(
  request: WorkspaceSearchReplaceRequest,
  root: string,
  signal: AbortSignal,
  onFile: (result: WorkspaceSearchReplaceFileResult) => void,
): Promise<ReplaceOutcome> {
  const problem = describeSearchQueryProblem(request.query);
  if (problem) return { error: problem, filesChanged: 0, replacements: 0 };
  const regex = createWorkspaceSearchRegExp(request);
  if (!regex) {
    return { error: "This pattern is not valid for replace.", filesChanged: 0, replacements: 0 };
  }
  let filesChanged = 0;
  let replacements = 0;
  for (const file of request.files) {
    if (signal.aborted) break;
    const result = await replaceInFile(path.resolve(root), file, regex, request);
    onFile(result);
    if (result.skippedReason === null) {
      filesChanged += 1;
      replacements += result.replacements;
    }
  }
  return { error: null, filesChanged, replacements };
}
