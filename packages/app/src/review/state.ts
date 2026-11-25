import { z } from "zod";

export type ReviewDraftMode = "uncommitted" | "base" | "all";
export type ReviewDraftSide = "old" | "new";

/** What a note covers and what surrounds it, so it can find its lines again after the diff changes. */
export interface ReviewNoteAnchor {
  /** The covered lines' text, first to last. */
  lines: string[];
  /** Up to `CONTEXT_RADIUS` lines before and after, within the same hunk and side. */
  before: string[];
  after: string[];
}

export interface ReviewDraftComment {
  id: string;
  filePath: string;
  side: ReviewDraftSide;
  /** The last line covered, and the line the note's thread draws under. */
  lineNumber: number;
  /** The first line of a range on the same side, never after `lineNumber`; absent for one line. */
  startLineNumber?: number;
  anchor?: ReviewNoteAnchor;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewDraftStoreState {
  drafts: Record<string, ReviewDraftComment[]>;
}

export interface SerializedReviewDraftState {
  drafts: Record<string, ReviewDraftComment[]>;
  activeModesByScope?: Record<string, ReviewDraftMode>;
}

const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const ReviewDraftCommentSchema: z.ZodType<ReviewDraftComment> = z.strictObject({
  id: z.string(),
  filePath: z.string(),
  side: z.enum(["old", "new"]),
  lineNumber: z.number().int().positive(),
  // COMPAT(@pimi:review-draft-store): notes saved before ranges and anchors have neither field.
  startLineNumber: z.number().int().positive().optional(),
  anchor: z
    .strictObject({
      lines: z.array(z.string()),
      before: z.array(z.string()),
      after: z.array(z.string()),
    })
    .optional(),
  body: z.string(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export const SerializedReviewDraftStateSchema: z.ZodType<SerializedReviewDraftState> =
  z.strictObject({
    drafts: z.record(z.string(), z.array(ReviewDraftCommentSchema)),
    // COMPAT(reviewDraftModes): v1 persisted this field; v2 discards it during migration.
    activeModesByScope: z.record(z.string(), z.enum(["uncommitted", "base"])).optional(),
  });

export function addCommentToState(
  state: ReviewDraftStoreState,
  input: { key: string; comment: ReviewDraftComment },
): ReviewDraftStoreState {
  return {
    ...state,
    drafts: {
      ...state.drafts,
      [input.key]: [...(state.drafts[input.key] ?? []), input.comment],
    },
  };
}

export function updateCommentInState(
  state: ReviewDraftStoreState,
  input: {
    key: string;
    id: string;
    updates: Partial<Pick<ReviewDraftComment, "body">>;
    updatedAt: string;
  },
): ReviewDraftStoreState {
  const comments = state.drafts[input.key] ?? [];
  if (!comments.some((comment) => comment.id === input.id)) {
    return state;
  }
  return {
    ...state,
    drafts: {
      ...state.drafts,
      [input.key]: comments.map((comment) =>
        applyCommentUpdates(comment, input.id, input.updates, input.updatedAt),
      ),
    },
  };
}

export function deleteCommentFromState(
  state: ReviewDraftStoreState,
  input: { key: string; id: string },
): ReviewDraftStoreState {
  const comments = state.drafts[input.key] ?? [];
  if (!comments.some((comment) => comment.id === input.id)) {
    return state;
  }
  return {
    ...state,
    drafts: {
      ...state.drafts,
      [input.key]: comments.filter((comment) => comment.id !== input.id),
    },
  };
}

export function deleteCommentsFromState(
  state: ReviewDraftStoreState,
  input: { key: string; ids: ReadonlySet<string> },
): ReviewDraftStoreState {
  const comments = state.drafts[input.key] ?? [];
  const remaining = comments.filter((comment) => !input.ids.has(comment.id));
  if (remaining.length === comments.length) {
    return state;
  }
  const nextDrafts = { ...state.drafts };
  if (remaining.length === 0) delete nextDrafts[input.key];
  else nextDrafts[input.key] = remaining;
  return { ...state, drafts: nextDrafts };
}

export interface ReviewCommentRelocation {
  id: string;
  filePath?: string;
  startLineNumber?: number;
  lineNumber?: number;
  anchor?: ReviewNoteAnchor;
}

function relocated(comment: ReviewDraftComment, relocation: ReviewCommentRelocation) {
  const { id: _id, ...moves } = relocation;
  const moved: ReviewDraftComment = { ...comment, ...moves };
  // A single line carries no start: it is the line itself.
  if (moved.startLineNumber !== undefined && moved.startLineNumber >= moved.lineNumber) {
    delete moved.startLineNumber;
  }
  return moved;
}

/** Applies where notes moved (or the anchor they gained) in one update; ids it does not know are skipped. */
export function relocateCommentsInState(
  state: ReviewDraftStoreState,
  input: { key: string; relocations: readonly ReviewCommentRelocation[] },
): ReviewDraftStoreState {
  const comments = state.drafts[input.key];
  if (!comments || input.relocations.length === 0) return state;
  const byId = new Map(input.relocations.map((relocation) => [relocation.id, relocation]));
  let changed = false;
  const next = comments.map((comment) => {
    const relocation = byId.get(comment.id);
    if (!relocation) return comment;
    changed = true;
    return relocated(comment, relocation);
  });
  return changed ? { ...state, drafts: { ...state.drafts, [input.key]: next } } : state;
}

export function clearReviewInState(
  state: ReviewDraftStoreState,
  input: { key: string },
): ReviewDraftStoreState {
  if (!state.drafts[input.key]) {
    return state;
  }
  const nextDrafts = { ...state.drafts };
  delete nextDrafts[input.key];
  return { ...state, drafts: nextDrafts };
}

export function serializeReviewDraftState(
  state: ReviewDraftStoreState,
): SerializedReviewDraftState {
  return {
    drafts: state.drafts,
  };
}

export function normalizePersistedState(state: unknown): ReviewDraftStoreState {
  const result = SerializedReviewDraftStateSchema.safeParse(state);
  return {
    drafts: result.success ? result.data.drafts : {},
  };
}

function applyCommentUpdates(
  comment: ReviewDraftComment,
  targetId: string,
  updates: Partial<Pick<ReviewDraftComment, "body">>,
  updatedAt: string,
): ReviewDraftComment {
  if (comment.id !== targetId) {
    return comment;
  }
  return { ...comment, body: updates.body ?? comment.body, updatedAt };
}
