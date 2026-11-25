// Forge threads and the user's own line notes on the shared DiffDocument without a new renderer.
// A forge thread draws as one marker row under its line (`InlineReviewActions.threadsByTarget`);
// pressing it opens the thread panel. Notes are the existing annotate-a-line flow
// (`useInlineReviewController`): they persist per review and travel to chat as a `review`
// attachment. Threads the document cannot place are listed in the strip above it.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "@/i18n/use-translation";
import type { ParsedDiffFile } from "@pimi/protocol/messages";
import {
  buildReviewDraftKey,
  groupInlineReviewCommentsByTarget,
  useInlineReviewController,
  type InlineForgeThreadMarker,
  type InlineReviewActions,
  type InlineReviewSubmitActions,
} from "@/review";
import { resolveNotes } from "@/review/anchor";
import { rangeBarKeys } from "@/review/surface";
import {
  relocateReviewDraftComments,
  useReviewCommentCount,
  useReviewDraftComments,
  type ReviewDraftComment,
} from "@/review/store";
import { buildReviewableDiffTargetKey, type ReviewableDiffTarget } from "@/utils/diff-layout";
import type { ChangeRequestSource } from "../types";
import { newMutationId, type WriteResult } from "../write/use-review-writes";
import type { ForgeThread } from "./use-desk-data";

export function reviewDraftKeyFor(source: ChangeRequestSource): string {
  return buildReviewDraftKey({
    serverId: source.serverId,
    cwd: `${source.forgeHost}/${source.owner}/${source.name}#${source.number}`,
    mode: "all",
    ignoreWhitespace: false,
  });
}

/**
 * Lines of a patch a comment can sit on, per side: the new side is context and added lines, the
 * old side is context and removed lines. A thread or draft outside these sets is not in the diff.
 */
export function commentableLines(file: ParsedDiffFile): { new: Set<number>; old: Set<number> } {
  const lines = { new: new Set<number>(), old: new Set<number>() };
  for (const hunk of file.hunks) {
    let nextNew = hunk.newStart;
    let nextOld = hunk.oldStart;
    for (const line of hunk.lines) {
      if (line.type === "header") continue;
      if (line.type !== "remove") {
        lines.new.add(nextNew);
        nextNew += 1;
      }
      if (line.type !== "add") {
        lines.old.add(nextOld);
        nextOld += 1;
      }
    }
  }
  return lines;
}

/** New-side lines a patch shows; a thread outside this set cannot be drawn under a line. */
export function newSideLines(file: ParsedDiffFile): Set<number> {
  return commentableLines(file).new;
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

export type PostLineComment = (input: {
  path: string;
  line: number;
  body: string;
  mutationId: string;
}) => Promise<WriteResult>;

export interface ReviewMarkers {
  reviewDraftKey: string;
  reviewActions: InlineReviewActions;
  /** The controller the compact comment sheet reads. */
  controller: ReturnType<typeof useInlineReviewController>;
  draftCount: number;
  /** Threads the document cannot draw: no line, or a line outside the patch. */
  detached: Array<{ thread: ForgeThread; reason: "no_line" | "outside_diff" }>;
  /** Notes whose quoted lines are not in the diff any more. They stay in the review. */
  outdatedNotes: ReviewDraftComment[];
  /** The thread the panel shows, if it is still on this review. */
  openThread: ForgeThread | null;
  onOpenThread: (id: string) => void;
  onCloseThread: () => void;
}

export function useReviewMarkers(input: {
  reviewDraftKey: string;
  threads: readonly ForgeThread[];
  loadedFiles: ReadonlyMap<string, ParsedDiffFile>;
  /** Every changed file without hunks; the ones not in `loadedFiles` have a patch still coming. */
  stubs: readonly ParsedDiffFile[];
  /** Posts a single line comment to the forge; null where the source has no forge to post to. */
  postLineComment: PostLineComment | null;
}): ReviewMarkers {
  const { reviewDraftKey, threads, loadedFiles, stubs, postLineComment } = input;
  const { t } = useTranslation();
  const controller = useInlineReviewController({ reviewDraftKey, presentation: "review-desk" });
  const draftCount = useReviewCommentCount(reviewDraftKey);
  const notes = useReviewDraftComments(reviewDraftKey);
  const pendingPaths = useMemo(() => {
    const pending = new Set<string>();
    for (const stub of stubs) {
      if (loadedFiles.has(stub.path)) continue;
      pending.add(stub.path);
      if (stub.oldPath) pending.add(stub.oldPath);
    }
    return pending;
  }, [loadedFiles, stubs]);
  const noteResolution = useMemo(
    () => resolveNotes(notes, loadedFiles, pendingPaths),
    [loadedFiles, notes, pendingPaths],
  );
  // The store is written only when a note moved or gained its anchor, so the next pass finds
  // nothing to do and the effect does not feed itself.
  const { relocations } = noteResolution;
  useEffect(() => {
    if (relocations.length > 0) relocateReviewDraftComments({ key: reviewDraftKey, relocations });
  }, [relocations, reviewDraftKey]);
  // An outdated note has no line in the diff; its stored line numbers would pin it to whatever
  // text sits there now, so it is listed instead of drawn.
  const { commentsByTarget, rangeBars } = useMemo(() => {
    const outdatedIds = new Set(noteResolution.outdated.map((note) => note.id));
    const placed = notes.filter((note) => !outdatedIds.has(note.id));
    return {
      commentsByTarget: groupInlineReviewCommentsByTarget(placed),
      rangeBars: rangeBarKeys(placed),
    };
  }, [noteResolution.outdated, notes]);
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

  // "Comment now": the editor closes at once and the thread appears under the line. If the post
  // fails the editor reopens on that line with the text and the reason. A retry of the same text
  // on the same line reuses the first attempt's mutation id, so the daemon posts it once.
  const [nowError, setNowError] = useState<{ targetKey: string; message: string } | null>(null);
  const attempt = useRef<{ key: string; body: string; mutationId: string } | null>(null);
  const { onCancelEditor, onStartComment, onChangeEditorBody } = controller;
  const onCommentNow = useCallback(
    (target: ReviewableDiffTarget, body: string) => {
      if (!postLineComment || !body) return;
      const previous = attempt.current;
      const mutationId =
        previous && previous.key === target.key && previous.body === body
          ? previous.mutationId
          : newMutationId();
      attempt.current = { key: target.key, body, mutationId };
      setNowError(null);
      onCancelEditor();
      void (async () => {
        const result = await postLineComment({
          path: target.filePath,
          line: target.lineNumber,
          body,
          mutationId,
        });
        if (result.ok) {
          attempt.current = null;
          return;
        }
        setNowError({ targetKey: target.key, message: result.failure.message });
        onStartComment(target);
        onChangeEditorBody(body);
      })();
    },
    [onCancelEditor, onChangeEditorBody, onStartComment, postLineComment],
  );
  const submit = useMemo<InlineReviewSubmitActions>(
    () => ({
      saveLabel: t(
        postLineComment ? "reviewScreen.write.addReviewComment" : "reviewScreen.write.addNote",
      ),
      commentNow: postLineComment
        ? { label: t("reviewScreen.write.commentNow"), error: nowError, onCommentNow }
        : null,
    }),
    [nowError, onCommentNow, postLineComment, t],
  );

  const reviewActions = useMemo<InlineReviewActions>(
    () => ({
      submit,
      commentsByTarget,
      rangeBars,
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
    [commentsByTarget, controller, onOpenThread, rangeBars, submit, threadsByTarget],
  );

  return {
    reviewDraftKey,
    reviewActions,
    controller,
    draftCount,
    outdatedNotes: noteResolution.outdated,
    detached,
    openThread,
    onOpenThread,
    onCloseThread,
  };
}
