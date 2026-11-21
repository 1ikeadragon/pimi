// Pimi. PolyForm-Noncommercial-1.0.0.
// Data the Files tab shares between sources: forge threads for the markers, the rule that picks
// continuous scroll or single-file mode from the totals, and the patch-less file stand-in.
import { useMemo } from "react";
import type { ChangeRequestFile, ParsedDiffFile } from "@pimi/protocol/messages";
import type { ChangeRequestSource, ReviewCountsByPath } from "../types";
import { useReviewTimeline } from "../use-review-timeline";

/**
 * Continuous scroll up to this many files and this much patch text; single-file mode above.
 * Compact screens keep the lower limit: less memory and a smaller canvas.
 */
const CONTINUOUS_LIMITS = {
  full: { files: 300, patchBytes: 4 * 1024 * 1024 },
  compact: { files: 50, patchBytes: 1024 * 1024 },
} as const;

export function chooseDiffMode(
  totals: { totalFiles: number; patchBytesTotal: number },
  isCompact: boolean,
): "continuous" | "single" {
  const limits = isCompact ? CONTINUOUS_LIMITS.compact : CONTINUOUS_LIMITS.full;
  return totals.totalFiles <= limits.files && totals.patchBytesTotal <= limits.patchBytes
    ? "continuous"
    : "single";
}

/** A patch-less stand-in for a file whose diff has not arrived: tree rows and document headers. */
export function stubFile(file: ChangeRequestFile): ParsedDiffFile {
  return {
    path: file.path,
    ...(file.oldPath ? { oldPath: file.oldPath } : {}),
    isNew: file.status === "added",
    isDeleted: file.status === "deleted",
    additions: file.additions,
    deletions: file.deletions,
    hunks: [],
    ...(file.patchBytes === null ? { status: "binary" as const } : {}),
  };
}

export interface ForgeThread {
  id: string;
  path: string;
  line: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  author: string;
  body: string;
  replies: number;
  url: string;
}

export interface DeskThreads {
  threads: ForgeThread[];
  counts: ReviewCountsByPath;
  error: string | null;
}

/** Forge threads through the shared timeline read (one cached fetch for every consumer). */
export function useDeskThreads(source: ChangeRequestSource): DeskThreads {
  const timeline = useReviewTimeline(source);
  const { threads: raw, counts, threadsError } = timeline;
  return useMemo<DeskThreads>(() => {
    const threads: ForgeThread[] = [];
    for (const thread of raw) {
      if (thread.path === null) continue;
      threads.push({
        id: thread.id,
        path: thread.path,
        line: thread.line,
        isResolved: thread.isResolved,
        isOutdated: thread.isOutdated,
        author: thread.author,
        body: thread.summary,
        replies: thread.entry.comments.length - 1,
        url: thread.url,
      });
    }
    return { threads, counts, error: threadsError?.message ?? null };
  }, [counts, raw, threadsError]);
}
