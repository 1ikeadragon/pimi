// Pimi. Apache-2.0.
// Inline markers and annotations on the shared DiffDocument without a new renderer: the document
// already paints `InlineReviewActions.commentsByTarget` under each line, so forge threads ride in
// as read-only entries next to the user's own draft annotations. Drafts are the existing
// annotate-a-line flow (`useInlineReviewController`); they persist per change request and travel
// to chat as a `review` attachment.
import { useCallback, useMemo, useState } from "react";
import type { ParsedDiffFile } from "@pimi/protocol/messages";
import { buildReviewDraftKey, useInlineReviewController, type ReviewDraftComment } from "@/review";
import type { InlineReviewActions } from "@/review";
import { useReviewCommentCount } from "@/review/store";
import { buildReviewableDiffTargetKey } from "@/utils/diff-layout";
import type { ChangeRequestSource } from "../types";
import type { ForgeThread } from "./use-desk-data";

const FORGE_ID_PREFIX = "forge:";

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

function threadComment(thread: ForgeThread, line: number): ReviewDraftComment {
  let state = "";
  if (thread.isResolved) state = " (resolved)";
  else if (thread.isOutdated) state = " (outdated)";
  const replies = thread.replies > 0 ? ` +${thread.replies}` : "";
  const stamp = new Date(0).toISOString();
  return {
    id: `${FORGE_ID_PREFIX}${thread.id}`,
    filePath: thread.path,
    side: "new",
    lineNumber: line,
    body: `${thread.author}${state}${replies}: ${thread.body}`,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

export interface ReviewMarkers {
  reviewDraftKey: string;
  reviewActions: InlineReviewActions;
  /** The controller the compact comment sheet reads. */
  controller: ReturnType<typeof useInlineReviewController>;
  draftCount: number;
  /** Threads the document cannot draw: no line, line outside the patch, or hidden by the user. */
  detached: Array<{ thread: ForgeThread; reason: "no_line" | "outside_diff" | "hidden" }>;
  showThread: (id: string) => void;
}

export function useReviewMarkers(input: {
  source: ChangeRequestSource;
  threads: readonly ForgeThread[];
  loadedFiles: ReadonlyMap<string, ParsedDiffFile>;
}): ReviewMarkers {
  const { source, threads, loadedFiles } = input;
  const reviewDraftKey = useMemo(() => reviewDraftKeyFor(source), [source]);
  const controller = useInlineReviewController({ reviewDraftKey, presentation: "review-desk" });
  const draftCount = useReviewCommentCount(reviewDraftKey);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());

  const { markers, detached } = useMemo(() => {
    const placed = new Map<string, ReviewDraftComment[]>();
    const loose: ReviewMarkers["detached"] = [];
    // Anchored lines are cached per file: threads outnumber loaded files on a large change request.
    const linesByPath = new Map<string, Set<number>>();
    for (const thread of threads) {
      if (hidden.has(thread.id)) {
        loose.push({ thread, reason: "hidden" });
        continue;
      }
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
      placed.set(key, [...(placed.get(key) ?? []), threadComment(thread, thread.line)]);
    }
    return { markers: placed, detached: loose };
  }, [hidden, loadedFiles, threads]);

  const { commentsByTarget, onEditComment, onDeleteComment } = controller;
  const merged = useMemo(() => {
    const out = new Map<string, ReviewDraftComment[]>();
    for (const [key, list] of markers) out.set(key, [...list]);
    for (const [key, list] of commentsByTarget) out.set(key, [...(out.get(key) ?? []), ...list]);
    return out;
  }, [commentsByTarget, markers]);

  const edit = useCallback<InlineReviewActions["onEditComment"]>(
    (target, comment) => {
      // Forge threads are read-only here; replying happens on the forge.
      if (comment.id.startsWith(FORGE_ID_PREFIX)) return;
      onEditComment(target, comment);
    },
    [onEditComment],
  );
  const remove = useCallback(
    (id: string) => {
      if (id.startsWith(FORGE_ID_PREFIX)) {
        // The trash button on a forge thread hides it in this view; the strip above the diff lists it.
        setHidden((current) => new Set(current).add(id.slice(FORGE_ID_PREFIX.length)));
        return;
      }
      onDeleteComment(id);
    },
    [onDeleteComment],
  );
  const showThread = useCallback(
    (id: string) =>
      setHidden((current) => {
        if (!current.has(id)) return current;
        const next = new Set(current);
        next.delete(id);
        return next;
      }),
    [],
  );

  const reviewActions = useMemo<InlineReviewActions>(
    () => ({
      commentsByTarget: merged,
      editor: controller.editor,
      onStartComment: controller.onStartComment,
      onEditComment: edit,
      onCancelEditor: controller.onCancelEditor,
      onChangeEditorBody: controller.onChangeEditorBody,
      onSaveEditor: controller.onSaveEditor,
      onDeleteComment: remove,
    }),
    [controller, edit, merged, remove],
  );

  return { reviewDraftKey, reviewActions, controller, draftCount, detached, showThread };
}
