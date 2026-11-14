// Pimi. PolyForm-Noncommercial-1.0.0.
// Data for the Changes tab: the file list of one change request, forge threads for the markers,
// and the rule that picks continuous scroll or single-file mode from the list's totals.
import { i18n } from "@/i18n/i18next";
import { useMemo } from "react";
import type { ChangeRequestFile, ParsedDiffFile } from "@pimi/protocol/messages";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { ChangeRequestSource, ReviewCountsByPath } from "../types";
import { useReviewTimeline } from "../use-review-timeline";

/** Continuous scroll up to this many files and this much patch text; single-file mode above. */
export const CONTINUOUS_MAX_FILES = 50;
export const CONTINUOUS_MAX_PATCH_BYTES = 1024 * 1024;

function refOf(source: ChangeRequestSource) {
  return {
    forgeHost: source.forgeHost,
    owner: source.owner,
    name: source.name,
    number: source.number,
  };
}

export function deskFilesQueryKey(source: ChangeRequestSource) {
  return [
    "review-desk",
    "files",
    source.serverId,
    source.forgeHost,
    source.owner,
    source.name,
    source.number,
  ] as const;
}

export interface DeskFileList {
  baseSha: string;
  headSha: string;
  totalFiles: number;
  patchBytesTotal: number;
  files: ChangeRequestFile[];
}

export type DeskFilesState =
  | { status: "loading" }
  | { status: "error"; message: string; retry: () => void }
  | { status: "ready"; list: DeskFileList; refresh: () => void };

export function useDeskFiles(source: ChangeRequestSource): DeskFilesState {
  const client = useHostRuntimeClient(source.serverId);
  const isConnected = useHostRuntimeIsConnected(source.serverId);
  const query = useFetchQuery({
    queryKey: deskFilesQueryKey(source),
    dataShape: "value",
    staleTimeMs: 60_000,
    retry: false,
    queryFn: async (): Promise<DeskFileList> => {
      if (!client) throw new Error(i18n.t("reviewScreen.errors.hostNotConnected"));
      const payload = await client.forgeChangeRequestListFiles(refOf(source));
      if (payload.error) throw new Error(payload.error.message);
      if (!payload.snapshot) throw new Error(i18n.t("reviewScreen.errors.noFileList"));
      return { ...payload.snapshot, files: payload.files };
    },
    enabled: Boolean(client) && isConnected,
    refetchOnWindowFocus: false,
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

export function chooseDiffMode(list: DeskFileList): "continuous" | "single" {
  return list.totalFiles <= CONTINUOUS_MAX_FILES &&
    list.patchBytesTotal <= CONTINUOUS_MAX_PATCH_BYTES
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
