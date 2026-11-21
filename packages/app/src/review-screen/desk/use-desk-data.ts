// Pimi. PolyForm-Noncommercial-1.0.0.
// Data for the Changes tab: the file list of one change request, forge threads for the markers,
// and the rule that picks continuous scroll or single-file mode from the list's totals.
import { useMemo } from "react";
import type { ChangeRequestFile, ParsedDiffFile } from "@pimi/protocol/messages";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { ChangeRequestSource, ReviewCountsByPath } from "../types";
import { filesQuery, type DeskFileList } from "../queries";
import { useReviewTimeline } from "../use-review-timeline";

/**
 * Continuous scroll up to this many files and this much patch text; single-file mode above.
 * Compact screens keep the lower limit: less memory and a smaller canvas.
 */
const CONTINUOUS_LIMITS = {
  full: { files: 300, patchBytes: 4 * 1024 * 1024 },
  compact: { files: 50, patchBytes: 1024 * 1024 },
} as const;

export type { DeskFileList };

export type DeskFilesState =
  | { status: "loading" }
  | { status: "error"; message: string; retry: () => void }
  | { status: "ready"; list: DeskFileList; refresh: () => void };

export function useDeskFiles(source: ChangeRequestSource): DeskFilesState {
  const client = useHostRuntimeClient(source.serverId);
  const isConnected = useHostRuntimeIsConnected(source.serverId);
  const query = useFetchQuery({
    ...filesQuery(source, client),
    enabled: Boolean(client) && isConnected,
  });
  const { refetch } = query;
  return useMemo<DeskFilesState>(() => {
    if (query.data) return { status: "ready", list: query.data, refresh: () => void refetch() };
    if (query.error) {
      return {
        status: "error",
        message: describeError(query.error) ?? "",
        retry: () => void refetch(),
      };
    }
    return { status: "loading" };
  }, [query.data, query.error, refetch]);
}

function describeError(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}

export function chooseDiffMode(list: DeskFileList, isCompact: boolean): "continuous" | "single" {
  const limits = isCompact ? CONTINUOUS_LIMITS.compact : CONTINUOUS_LIMITS.full;
  return list.totalFiles <= limits.files && list.patchBytesTotal <= limits.patchBytes
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

/** Forge threads through stream S4's shared timeline read (one cached fetch for every consumer). */
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
