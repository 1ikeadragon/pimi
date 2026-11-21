// Forge threads and the user's own line notes on the shared DiffDocument without a new renderer.
// A forge thread draws as one marker row under its line (`InlineReviewActions.threadsByTarget`);
// pressing it opens the thread panel. Notes are the existing annotate-a-line flow
// (`useInlineReviewController`): they persist per review and travel to chat as a `review`
// attachment. Threads the document cannot place are listed in the strip above it.
import { useCallback, useMemo, useState } from "react";
import type { ParsedDiffFile } from "@pimi/protocol/messages";
import {
  buildReviewDraftKey,
  useInlineReviewController,
  type InlineForgeThreadMarker,
  type InlineReviewActions,
} from "@/review";
import { useReviewCommentCount } from "@/review/store";
import { buildReviewableDiffTargetKey } from "@/utils/diff-layout";
import type { ChangeRequestSource } from "../types";
import type { ForgeThread } from "./use-desk-data";

export function reviewDraftKeyFor(source: ChangeRequestSource): string {
  return buildReviewDraftKey({
    serverId: source.serverId,
    cwd: `${source.forgeHost}/${source.owner}/${source.name}#${source.number}`,
    mode: "all",
    ignoreWhitespace: false,
  });
}

/** New-side lines a patch shows; a thread outside this set cannot be drawn under a line. */
export function newSideLines(file: ParsedDiffFile): Set<number> {
  const lines = new Set<number>();
  for (const hunk of file.hunks) {
    let next = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.type === "header" || line.type === "remove") continue;
      lines.add(next);
      next += 1;
    }
  }
  return lines;
}

function toMarker(thread: ForgeThread): InlineForgeThreadMarker {
  return {
    id: thread.id,
    author: thread.author,
    summary: thread.body,
    replies: thread.replies,
    isResolved: thread.isResolved,
    isOutdated: thread.isOutdated,
  };
}

export interface ReviewMarkers {
  reviewDraftKey: string;
  reviewActions: InlineReviewActions;
  /** The controller the compact comment sheet reads. */
  controller: ReturnType<typeof useInlineReviewController>;
  draftCount: number;
  /** Threads the document cannot draw: no line, or a line outside the patch. */
  detached: Array<{ thread: ForgeThread; reason: "no_line" | "outside_diff" }>;
  /** The thread the panel shows, if it is still on this review. */
  openThread: ForgeThread | null;
  onOpenThread: (id: string) => void;
  onCloseThread: () => void;
}

export function useReviewMarkers(input: {
  reviewDraftKey: string;
  threads: readonly ForgeThread[];
  loadedFiles: ReadonlyMap<string, ParsedDiffFile>;
}): ReviewMarkers {
  const { reviewDraftKey, threads, loadedFiles } = input;
  const controller = useInlineReviewController({ reviewDraftKey, presentation: "review-desk" });
  const draftCount = useReviewCommentCount(reviewDraftKey);
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);

  const { threadsByTarget, detached } = useMemo(() => {
    const placed = new Map<string, InlineForgeThreadMarker[]>();
    const loose: ReviewMarkers["detached"] = [];
    // Anchored lines are cached per file: threads outnumber loaded files on a large change request.
    const linesByPath = new Map<string, Set<number>>();
    for (const thread of threads) {
      if (thread.line === null) {
        loose.push({ thread, reason: "no_line" });
        continue;
      }
      const file = loadedFiles.get(thread.path);
      if (file) {
        let lines = linesByPath.get(thread.path);
        if (!lines) {
          lines = newSideLines(file);
          linesByPath.set(thread.path, lines);
        }
        if (!lines.has(thread.line)) {
          loose.push({ thread, reason: "outside_diff" });
          continue;
        }
      }
      const key = buildReviewableDiffTargetKey({
        filePath: thread.path,
        side: "new",
        lineNumber: thread.line,
      });
      const marker = toMarker(thread);
      placed.set(key, [...(placed.get(key) ?? []), marker]);
    }
    return { threadsByTarget: placed, detached: loose };
  }, [loadedFiles, threads]);

  const onOpenThread = useCallback((id: string) => setOpenThreadId(id), []);
  const onCloseThread = useCallback(() => setOpenThreadId(null), []);
  const openThread = useMemo(
    () => (openThreadId ? (threads.find((thread) => thread.id === openThreadId) ?? null) : null),
    [openThreadId, threads],
  );

  const reviewActions = useMemo<InlineReviewActions>(
    () => ({
      commentsByTarget: controller.commentsByTarget,
      threadsByTarget,
      onOpenThread,
      editor: controller.editor,
      onStartComment: controller.onStartComment,
      onEditComment: controller.onEditComment,
      onCancelEditor: controller.onCancelEditor,
      onChangeEditorBody: controller.onChangeEditorBody,
      onSaveEditor: controller.onSaveEditor,
      onDeleteComment: controller.onDeleteComment,
    }),
    [controller, onOpenThread, threadsByTarget],
  );

  return {
    reviewDraftKey,
    reviewActions,
    controller,
    draftCount,
    detached,
    openThread,
    onOpenThread,
    onCloseThread,
  };
}
