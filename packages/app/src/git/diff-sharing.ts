import { replaceEqualDeep } from "@tanstack/react-query";
import type { ParsedDiffFile, SubscribeCheckoutDiffResponse } from "@pimi/protocol/messages";

type DiffPayload = Omit<SubscribeCheckoutDiffResponse["payload"], "subscriptionId">;

/**
 * The file an incoming one replaced when the two differ only in syntax tokens. The daemon sends a
 * cold diff first without tokens and again with them; the second file is a new object (its tokens
 * are new data) but its text, and so every row's geometry, is the first's. The document model
 * reads this to recolour the first's rows instead of laying the file out again.
 */
const textPredecessors = new WeakMap<ParsedDiffFile, ParsedDiffFile>();

export function textPredecessorOf(file: ParsedDiffFile): ParsedDiffFile | undefined {
  return textPredecessors.get(file);
}

/** Whether `next` replaces `previous` with nothing changed but syntax tokens, file for file. */
export function isTokenOnlyUpdate(
  previous: readonly ParsedDiffFile[],
  next: readonly ParsedDiffFile[],
): boolean {
  return (
    previous.length === next.length &&
    next.every(
      (file, index) => file === previous[index] || textPredecessors.get(file) === previous[index],
    )
  );
}

/** File identity owns text-model reuse. Never reconstruct the hunk/token graph. */
export function retainDiffFiles(
  previous: ParsedDiffFile[],
  incoming: ParsedDiffFile[],
): ParsedDiffFile[] {
  if (previous === incoming) return previous;
  const byPath = new Map(previous.map((file) => [file.path, file]));
  let unchanged = previous.length === incoming.length;
  const files = incoming.map((file, index) => {
    const old = byPath.get(file.path);
    let retained = file;
    if (old) {
      const relation = compareFiles(old, file);
      if (relation === "same") retained = old;
      else if (relation === "tokens") textPredecessors.set(file, old);
    }
    unchanged &&= retained === previous[index];
    return retained;
  });
  return unchanged ? previous : files;
}

export function shareCheckoutDiff(previous: unknown, incoming: unknown): DiffPayload {
  const next = incoming as DiffPayload;
  const old = previous as DiffPayload | undefined;
  if (!old || old === next) return next;
  const files = retainDiffFiles(old.files, next.files);
  const error = replaceEqualDeep(old.error, next.error);
  return files === old.files &&
    error === old.error &&
    old.cwd === next.cwd &&
    old.requestId === next.requestId &&
    old.diffTooLarge === next.diffTooLarge
    ? old
    : { ...next, files, error };
}

export function shareCommitFileDiff(
  previous: unknown,
  incoming: unknown,
): { file: ParsedDiffFile | null } {
  const next = incoming as { file: ParsedDiffFile | null };
  const old = previous as typeof next | undefined;
  return old &&
    (old.file === next.file ||
      (old.file && next.file && compareFiles(old.file, next.file) === "same"))
    ? old
    : next;
}

type FileRelation = "same" | "tokens" | "different";

/** `tokens` is the same text with other syntax tokens; `different` is any change to the text. */
function compareFiles(left: ParsedDiffFile, right: ParsedDiffFile): FileRelation {
  if (left === right) return "same";
  if (
    left.path !== right.path ||
    left.oldPath !== right.oldPath ||
    left.status !== right.status ||
    left.isNew !== right.isNew ||
    left.isDeleted !== right.isDeleted ||
    left.additions !== right.additions ||
    left.deletions !== right.deletions ||
    left.hunks.length !== right.hunks.length
  )
    return "different";
  let relation: FileRelation = "same";
  for (let h = 0; h < left.hunks.length; h++) {
    const a = left.hunks[h]!;
    const b = right.hunks[h]!;
    if (a === b) continue;
    if (
      a.oldStart !== b.oldStart ||
      a.oldCount !== b.oldCount ||
      a.newStart !== b.newStart ||
      a.newCount !== b.newCount ||
      a.lines.length !== b.lines.length
    )
      return "different";
    const lines = compareLines(a.lines, b.lines);
    if (lines === "different") return "different";
    if (lines === "tokens") relation = "tokens";
  }
  return relation;
}

function compareLines(
  left: ParsedDiffFile["hunks"][number]["lines"],
  right: ParsedDiffFile["hunks"][number]["lines"],
): FileRelation {
  let relation: FileRelation = "same";
  for (let l = 0; l < left.length; l++) {
    const x = left[l]!;
    const y = right[l]!;
    if (x === y) continue;
    if (x.type !== y.type || x.content !== y.content) return "different";
    if (!equalTokens(x.tokens, y.tokens)) relation = "tokens";
  }
  return relation;
}

function equalTokens(
  left: ParsedDiffFile["hunks"][number]["lines"][number]["tokens"],
  right: ParsedDiffFile["hunks"][number]["lines"][number]["tokens"],
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  for (let t = 0; t < left.length; t++) {
    if (left[t]!.text !== right[t]!.text || left[t]!.style !== right[t]!.style) return false;
  }
  return true;
}
