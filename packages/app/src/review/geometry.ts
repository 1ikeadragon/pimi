import type { ReviewableDiffTarget } from "@/utils/diff-layout";
import { buildReviewableDiffTargetKey } from "@/utils/diff-layout";
import type { ReviewDraftComment } from "./store";

export const INLINE_REVIEW_COMMENT_HEIGHT = 72;
export const INLINE_REVIEW_EDITOR_HEIGHT = 90;
/** One forge thread under its line: a single row, whatever the thread says. */
export const INLINE_REVIEW_MARKER_HEIGHT = 40;
export const INLINE_REVIEW_BLOCK_MAX_WIDTH = 560;
export const INLINE_REVIEW_GAP = 6;
export const INLINE_REVIEW_VERTICAL_PADDING = 8;

export interface InlineReviewEditorState {
  target: ReviewableDiffTarget;
  commentId: string | null;
  body: string;
  /** The first line when the note covers a range ending at `target`. */
  startLineNumber?: number;
}

/** A forge thread drawn as one row under its line; pressing it opens the thread elsewhere. */
export interface InlineForgeThreadMarker {
  id: string;
  author: string;
  /** First line of the opening comment, markup stripped. */
  summary: string;
  replies: number;
  isResolved: boolean;
  isOutdated: boolean;
}

/**
 * What the review desk adds to the inline editor: its own label for saving a local pending
 * comment, and, on a pull request, a second action that posts the comment to the forge at once.
 */
export interface InlineReviewSubmitActions {
  saveLabel: string;
  commentNow: {
    label: string;
    /** Why the last attempt on `targetKey` failed; shown in the editor row. */
    error: { targetKey: string; message: string } | null;
    onCommentNow: (target: ReviewableDiffTarget, body: string) => void;
  } | null;
}

export interface InlineReviewActions {
  commentsByTarget: ReadonlyMap<string, ReviewDraftComment[]>;
  /** Forge threads by target. Absent where there are none (the chat Changes pane). */
  threadsByTarget?: ReadonlyMap<string, InlineForgeThreadMarker[]>;
  onOpenThread?: (id: string) => void;
  /**
   * Target keys of every line a range note covers, for the gutter bar. Absent where notes are
   * single lines only.
   */
  rangeBars?: ReadonlySet<string>;
  /** Absent in the chat Changes pane, which keeps the plain "Comment" editor. */
  submit?: InlineReviewSubmitActions;
  editor: InlineReviewEditorState | null;
  onStartComment: (target: ReviewableDiffTarget, startLineNumber?: number) => void;
  onEditComment: (target: ReviewableDiffTarget, comment: ReviewDraftComment) => void;
  onCancelEditor: () => void;
  onChangeEditorBody: (body: string) => void;
  onSaveEditor: (body: string) => void;
  onDeleteComment: (id: string) => void;
}

const NO_MARKERS: InlineForgeThreadMarker[] = [];

export function isInlineReviewEditorForTarget(
  editor: InlineReviewEditorState | null,
  target: ReviewableDiffTarget | null | undefined,
): boolean {
  return Boolean(
    editor &&
    target &&
    buildReviewableDiffTargetKey(editor.target) === buildReviewableDiffTargetKey(target),
  );
}

export function getInlineReviewThreadState(input: {
  reviewTarget: ReviewableDiffTarget | null | undefined;
  reviewActions?: InlineReviewActions;
}): {
  comments: ReviewDraftComment[];
  markers: InlineForgeThreadMarker[];
  hasEditor: boolean;
  editingCommentId: string | null;
  height: number;
} | null {
  const { reviewTarget, reviewActions } = input;
  if (!reviewTarget || !reviewActions) return null;

  const comments = reviewActions.commentsByTarget.get(reviewTarget.key) ?? [];
  const markers = reviewActions.threadsByTarget?.get(reviewTarget.key) ?? NO_MARKERS;
  const editorForTarget = isInlineReviewEditorForTarget(reviewActions.editor, reviewTarget)
    ? reviewActions.editor
    : null;
  const hasEditor = editorForTarget !== null;
  const editingCommentId = editorForTarget?.commentId ?? null;
  const editingExisting =
    editingCommentId !== null && comments.some((comment) => comment.id === editingCommentId);
  const visibleCommentCount = editingExisting ? comments.length - 1 : comments.length;
  const editorCount = hasEditor ? 1 : 0;
  const visibleBlockCount = markers.length + visibleCommentCount + editorCount;
  if (visibleBlockCount === 0) return null;

  const height =
    markers.length * INLINE_REVIEW_MARKER_HEIGHT +
    visibleCommentCount * INLINE_REVIEW_COMMENT_HEIGHT +
    editorCount * INLINE_REVIEW_EDITOR_HEIGHT +
    Math.max(0, visibleBlockCount - 1) * INLINE_REVIEW_GAP +
    INLINE_REVIEW_VERTICAL_PADDING * 2;
  return { comments, markers, hasEditor, editingCommentId, height };
}

export function getSplitInlineReviewThreadState(input: {
  left: ReviewableDiffTarget | null | undefined;
  right: ReviewableDiffTarget | null | undefined;
  reviewActions?: InlineReviewActions;
}): {
  left: ReturnType<typeof getInlineReviewThreadState>;
  right: ReturnType<typeof getInlineReviewThreadState>;
  height: number;
} | null {
  const left = getInlineReviewThreadState({
    reviewTarget: input.left,
    reviewActions: input.reviewActions,
  });
  const right = getInlineReviewThreadState({
    reviewTarget: input.right,
    reviewActions: input.reviewActions,
  });
  const height = Math.max(left?.height ?? 0, right?.height ?? 0);
  return height === 0 ? null : { left, right, height };
}
