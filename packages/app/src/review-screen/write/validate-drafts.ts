// Pimi. PolyForm-Noncommercial-1.0.0.
// Pending line comments were written against whatever the diff was when the user wrote them. A
// push can move or remove the line, and the forge refuses a comment on a line outside the diff.
// Before a review is submitted, every draft is checked against the patches of the commit that is
// about to be reviewed.
import { useEffect, useMemo } from "react";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { ReviewDraftComment } from "@/review/store";
import { commentableLines } from "../desk/use-review-markers";
import {
  fetchPatches,
  patchKey,
  peekPatch,
  usePatchCacheVersion,
  type PatchEntry,
} from "../desk/patch-cache";
import type { ChangeRequestSource } from "../types";

export interface DraftValidation {
  /** Every draft's patch has been read (or failed); `mismatched` is final. */
  ready: boolean;
  /** Drafts whose line is not in the diff of `headSha`, or whose file could not be read. */
  mismatched: ReviewDraftComment[];
}

const NOT_READY: DraftValidation = { ready: false, mismatched: [] };

function matches(entry: PatchEntry, draft: ReviewDraftComment): boolean {
  if (entry.state === "failed") return false;
  const file = entry.diff.file;
  if (!file) return false;
  return commentableLines(file)[draft.side].has(draft.lineNumber);
}

export function useDraftValidation(
  source: ChangeRequestSource,
  headSha: string | null,
  drafts: readonly ReviewDraftComment[],
  enabled: boolean,
): DraftValidation {
  const client = useHostRuntimeClient(source.serverId);
  const version = usePatchCacheVersion();
  const pathsKey = useMemo(() => [...new Set(drafts.map((d) => d.filePath))].join("\n"), [drafts]);

  useEffect(() => {
    if (!enabled || !client || !headSha || pathsKey === "") return;
    const paths = pathsKey.split("\n");
    fetchPatches({ client, source, headSha, paths, keep: paths });
  }, [client, enabled, headSha, pathsKey, source]);

  return useMemo(() => {
    if (!enabled || !headSha) return NOT_READY;
    const mismatched: ReviewDraftComment[] = [];
    for (const draft of drafts) {
      const entry = peekPatch(patchKey(source, headSha, draft.filePath));
      if (!entry) return NOT_READY;
      if (!matches(entry, draft)) mismatched.push(draft);
    }
    return { ready: true, mismatched };
    // `version` is the invalidation signal for the module-level patch cache read above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts, enabled, headSha, source, version]);
}
