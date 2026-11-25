import { useMemo } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ComposerAttachment } from "@/attachments/types";
import type { ParsedDiffFile } from "@/git/use-diff-query";
import {
  addCommentToState,
  clearReviewInState,
  deleteCommentFromState,
  deleteCommentsFromState,
  relocateCommentsInState,
  type ReviewCommentRelocation,
  normalizePersistedState,
  type ReviewDraftComment,
  type ReviewDraftMode,
  type ReviewDraftSide,
  type ReviewDraftStoreState,
  serializeReviewDraftState,
  SerializedReviewDraftStateSchema,
  updateCommentInState,
} from "@/review/state";
import { CONTEXT_RADIUS, noteStartLine } from "@/review/anchor";
import { generateMessageId } from "@/types/stream";
import { buildNumberedDiffHunks, type NumberedDiffLine } from "@/utils/diff-layout";
import type { AgentAttachment } from "@pimi/protocol/messages";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

export type { ReviewDraftComment, ReviewDraftMode, ReviewDraftSide } from "@/review/state";

// v2 dropped the legacy persisted activeModesByScope field.
const STORE_VERSION = 2;
const EMPTY_REVIEW_DRAFT_COMMENTS: ReviewDraftComment[] = [];

type ReviewAttachment = Extract<AgentAttachment, { type: "review" }>;
type ReviewAttachmentContextLine = ReviewAttachment["comments"][number]["context"]["targetLine"];
type ReviewComposerAttachment = Extract<ComposerAttachment, { kind: "review" }>;

export interface BuildReviewDraftKeyInput {
  serverId: string;
  workspaceId?: string | null;
  cwd: string;
  mode: ReviewDraftMode;
  baseRef?: string | null;
  ignoreWhitespace: boolean;
}

type BuildReviewDraftScopeKeyInput = Omit<BuildReviewDraftKeyInput, "mode">;

export interface BuildReviewAttachmentSnapshotInput {
  reviewDraftKey: string;
  cwd: string;
  mode: ReviewDraftMode;
  baseRef?: string | null;
  comments: readonly ReviewDraftComment[];
  diffFiles: readonly ParsedDiffFile[];
}

export type ReviewDraftCommentInput = Omit<ReviewDraftComment, "id" | "createdAt" | "updatedAt"> &
  Partial<Pick<ReviewDraftComment, "id" | "createdAt" | "updatedAt">>;

interface ReviewDraftStoreActions {
  addComment: (input: { key: string; comment: ReviewDraftCommentInput }) => ReviewDraftComment;
  updateComment: (input: {
    key: string;
    id: string;
    updates: Partial<Pick<ReviewDraftComment, "body">>;
    updatedAt?: string;
  }) => void;
  deleteComment: (input: { key: string; id: string }) => void;
  /** Moves notes the diff moved, and gives anchors to notes that had none, in one update. */
  relocateComments: (input: {
    key: string;
    relocations: readonly ReviewCommentRelocation[];
  }) => void;
  /** Removes several notes in one update, so a subscriber never sees half of them gone. */
  deleteComments: (input: { key: string; ids: ReadonlySet<string> }) => void;
  clearReview: (input: { key: string }) => void;
}

type ReviewDraftStore = ReviewDraftStoreState & ReviewDraftStoreActions;

function encodeKeyPart(value: string): string {
  return encodeURIComponent(value.trim());
}

function normalizeCwd(cwd: string): string {
  const trimmed = cwd.trim();
  if (trimmed === "/") {
    return trimmed;
  }
  return trimmed.replace(/\/+$/, "");
}

function normalizeBaseRef(baseRef: string | null | undefined): string {
  return baseRef?.trim() ?? "";
}

function buildReviewDraftScopeParts(input: BuildReviewDraftScopeKeyInput): string[] {
  const workspaceId = input.workspaceId?.trim();
  // workspaceId is opaque; do not parse this key back into a path.
  const workspacePart = workspaceId
    ? `workspace=${encodeKeyPart(workspaceId)}`
    : `cwd=${encodeKeyPart(normalizeCwd(input.cwd))}`;

  return [
    "review",
    `server=${encodeKeyPart(input.serverId)}`,
    workspacePart,
    `base=${encodeKeyPart(normalizeBaseRef(input.baseRef))}`,
    `ignoreWhitespace=${input.ignoreWhitespace ? "true" : "false"}`,
  ];
}

export function buildReviewDraftKey(input: BuildReviewDraftKeyInput): string {
  const [prefix, serverPart, workspacePart, basePart, whitespacePart] =
    buildReviewDraftScopeParts(input);
  return [prefix, serverPart, workspacePart, `mode=${input.mode}`, basePart, whitespacePart].join(
    ":",
  );
}

function createDraftComment(input: ReviewDraftCommentInput): ReviewDraftComment {
  const now = new Date().toISOString();
  return {
    id: input.id ?? generateMessageId(),
    filePath: input.filePath,
    side: input.side,
    lineNumber: input.lineNumber,
    ...(input.startLineNumber !== undefined && input.startLineNumber < input.lineNumber
      ? { startLineNumber: input.startLineNumber }
      : {}),
    ...(input.anchor ? { anchor: input.anchor } : {}),
    body: input.body,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? input.createdAt ?? now,
  };
}

export const useReviewDraftStore = create<ReviewDraftStore>()(
  persist(
    (set) => ({
      drafts: {},
      addComment: ({ key, comment }) => {
        const nextComment = createDraftComment(comment);
        set((state) => addCommentToState(state, { key, comment: nextComment }));
        return nextComment;
      },
      updateComment: ({ key, id, updates, updatedAt }) => {
        set((state) =>
          updateCommentInState(state, {
            key,
            id,
            updates,
            updatedAt: updatedAt ?? new Date().toISOString(),
          }),
        );
      },
      deleteComment: (input) => {
        set((state) => deleteCommentFromState(state, input));
      },
      relocateComments: (input) => {
        set((state) => relocateCommentsInState(state, input));
      },
      deleteComments: (input) => {
        set((state) => deleteCommentsFromState(state, input));
      },
      clearReview: (input) => {
        set((state) => clearReviewInState(state, input));
      },
    }),
    {
      name: "@pimi:review-draft-store",
      version: STORE_VERSION,
      storage: createValidatedPersistStorage(AsyncStorage, SerializedReviewDraftStateSchema),
      partialize: (state) => serializeReviewDraftState(state),
      migrate: async (state) => normalizePersistedState(state),
    },
  ),
);

function toContextLine(line: NumberedDiffLine): ReviewAttachmentContextLine | null {
  if (line.line.type === "header") {
    return null;
  }
  return {
    oldLineNumber: line.oldLineNumber,
    newLineNumber: line.newLineNumber,
    type: line.line.type,
    content: line.line.content,
  };
}

function findTarget(input: { comment: ReviewDraftComment; diffFiles: readonly ParsedDiffFile[] }): {
  hunkHeader: string;
  hunkLines: NumberedDiffLine[];
  targetIndex: number;
  targetLine: NumberedDiffLine;
} | null {
  const file = input.diffFiles.find((candidate) => candidate.path === input.comment.filePath);
  if (!file) {
    return null;
  }

  for (const hunk of buildNumberedDiffHunks(file)) {
    const targetIndex = hunk.lines.findIndex((line) => {
      const cell = input.comment.side === "old" ? line.oldCell : line.newCell;
      return cell?.lineNumber === input.comment.lineNumber;
    });
    const targetLine = hunk.lines[targetIndex];
    if (targetLine) {
      return {
        hunkHeader: hunk.hunkHeader,
        hunkLines: hunk.lines,
        targetIndex,
        targetLine,
      };
    }
  }

  return null;
}

export interface ReviewAttachmentSnapshot {
  /** The notes whose line is in the diff, ready to send; null when none are. */
  attachment: ReviewComposerAttachment | null;
  /** Notes whose line is not in the diff, or whose file's patch is not loaded. Never sent, never deleted. */
  unplaced: ReviewDraftComment[];
}

export function buildReviewAttachmentSnapshot(
  input: BuildReviewAttachmentSnapshotInput,
): ReviewAttachmentSnapshot {
  const comments: ReviewAttachment["comments"] = [];
  const commentIds: string[] = [];
  const unplaced: ReviewDraftComment[] = [];

  for (const draftComment of input.comments) {
    const target = findTarget({
      comment: draftComment,
      diffFiles: input.diffFiles,
    });
    const targetLine = target ? toContextLine(target.targetLine) : null;
    if (!target || !targetLine) {
      unplaced.push(draftComment);
      continue;
    }

    const contextStart = Math.max(0, target.targetIndex - CONTEXT_RADIUS);
    const contextEnd = Math.min(target.hunkLines.length, target.targetIndex + CONTEXT_RADIUS + 1);
    const lines = target.hunkLines
      .slice(contextStart, contextEnd)
      .map(toContextLine)
      .filter((line): line is ReviewAttachmentContextLine => line !== null);

    commentIds.push(draftComment.id);
    comments.push({
      filePath: draftComment.filePath,
      side: draftComment.side,
      lineNumber: draftComment.lineNumber,
      // The attachment names one line; a range's first line travels in the text so it is not lost.
      body:
        noteStartLine(draftComment) < draftComment.lineNumber
          ? `Lines ${noteStartLine(draftComment)}-${draftComment.lineNumber}: ${draftComment.body}`
          : draftComment.body,
      context: {
        hunkHeader: target.hunkHeader,
        targetLine,
        lines,
      },
    });
  }

  if (comments.length === 0) {
    return { attachment: null, unplaced };
  }

  const attachment: ReviewAttachment = {
    type: "review",
    mimeType: "application/pimi-review",
    cwd: input.cwd,
    mode: input.mode,
    baseRef: normalizeBaseRef(input.baseRef) || null,
    comments,
  };

  return {
    attachment: {
      kind: "review",
      reviewDraftKey: input.reviewDraftKey,
      commentCount: comments.length,
      commentIds,
      attachment,
    },
    unplaced,
  };
}

export function useReviewDraftComments(key: string): ReviewDraftComment[] {
  return useReviewDraftStore((state) => state.drafts[key] ?? EMPTY_REVIEW_DRAFT_COMMENTS);
}

export function useDeleteReviewDraftComments(): ReviewDraftStoreActions["deleteComments"] {
  return useReviewDraftStore((state) => state.deleteComments);
}

export function addReviewDraftComment(input: {
  key: string;
  comment: ReviewDraftCommentInput;
}): ReviewDraftComment {
  return useReviewDraftStore.getState().addComment(input);
}

export function getReviewDraftComments(key: string): ReviewDraftComment[] | undefined {
  return useReviewDraftStore.getState().drafts[key];
}

export function resetReviewDraftStore(): void {
  useReviewDraftStore.setState({ drafts: {} });
}

export function useReviewDraftCommentsForAttachment(input: {
  key: string;
  enabled: boolean;
}): ReviewDraftComment[] {
  return useReviewDraftStore((state) =>
    input.enabled
      ? (state.drafts[input.key] ?? EMPTY_REVIEW_DRAFT_COMMENTS)
      : EMPTY_REVIEW_DRAFT_COMMENTS,
  );
}

export function useReviewCommentCount(key: string): number {
  return useReviewDraftStore((state) => state.drafts[key]?.length ?? 0);
}

export function useReviewAttachmentSnapshot(input: {
  key: string;
  diffFiles: readonly ParsedDiffFile[];
  cwd: string;
  mode: ReviewDraftMode;
  baseRef?: string | null;
}): ReviewComposerAttachment | null {
  const comments = useReviewDraftComments(input.key);
  return useMemo(
    () =>
      buildReviewAttachmentSnapshot({
        reviewDraftKey: input.key,
        cwd: input.cwd,
        mode: input.mode,
        baseRef: input.baseRef,
        comments,
        diffFiles: input.diffFiles,
      }).attachment,
    [comments, input.key, input.cwd, input.mode, input.baseRef, input.diffFiles],
  );
}

/** Acknowledgement can remove the original while the user still has an edit open. */
export function saveReviewDraftComment(input: {
  key: string;
  id: string | null;
  comment: Pick<ReviewDraftComment, "filePath" | "side" | "lineNumber" | "body"> &
    Partial<Pick<ReviewDraftComment, "startLineNumber" | "anchor">>;
}): void {
  const store = useReviewDraftStore.getState();
  if (input.id && store.drafts[input.key]?.some((comment) => comment.id === input.id)) {
    store.updateComment({ key: input.key, id: input.id, updates: { body: input.comment.body } });
  } else {
    store.addComment({
      key: input.key,
      comment: {
        filePath: input.comment.filePath,
        side: input.comment.side,
        lineNumber: input.comment.lineNumber,
        startLineNumber: input.comment.startLineNumber,
        anchor: input.comment.anchor,
        body: input.comment.body,
      },
    });
  }
}

export function relocateReviewDraftComments(input: {
  key: string;
  relocations: readonly ReviewCommentRelocation[];
}): void {
  useReviewDraftStore.getState().relocateComments(input);
}
