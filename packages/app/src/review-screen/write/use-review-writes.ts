// Pimi. PolyForm-Noncommercial-1.0.0.
// The Review screen's writes to the forge: comment, reply, resolve, submit review. One
// `mutationId` per user action, reused by every retry of that action, is what lets the daemon run
// a request at most once when a timeout over the relay is followed by a resend. Replies, comments
// and resolve show at once by editing the cached timeline; a failure takes the edit back out. A
// review submit is never optimistic: approving must not look done before the forge says so.
import { createContext, useCallback, useContext, useMemo } from "react";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type {
  ChangeRequestTimelineItem,
  ForgeChangeRequestSubmitReviewRequest,
} from "@pimi/protocol/messages";
import { i18n } from "@/i18n/i18next";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { refreshAfterWrite, reviewKeys, type ChangeRequestOverview } from "../queries";
import type { ChangeRequestSource } from "../types";

interface TimelineData {
  items: ChangeRequestTimelineItem[];
  truncated: boolean;
}
type ReviewEvent = ForgeChangeRequestSubmitReviewRequest["event"];
export type ReviewLineComment = ForgeChangeRequestSubmitReviewRequest["comments"][number];

/** A daemon refusal or a transport failure; `code` is the daemon's, or "transport". */
export interface WriteFailure {
  code: string;
  message: string;
}
export type WriteResult = { ok: true } | { ok: false; failure: WriteFailure };

class WriteError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const PENDING_PREFIX = "pending:";

/** Timeline ids this client invented for a comment that is still being sent. */
export function isPendingTimelineId(id: string): boolean {
  return id.startsWith(PENDING_PREFIX);
}

export function newMutationId(): string {
  return globalThis.crypto.randomUUID();
}

function toFailure(error: unknown): WriteFailure {
  if (error instanceof WriteError) return { code: error.code, message: error.message };
  const message = error instanceof Error ? error.message : String(error ?? "");
  return { code: "transport", message: message || i18n.t("reviewScreen.write.sendFailed") };
}

function guard<T>(payload: { error: { code: string; message: string } | null } & T): T {
  if (payload.error) throw new WriteError(payload.error.code, payload.error.message);
  return payload;
}

function editTimeline(
  queryClient: QueryClient,
  ref: ChangeRequestSource,
  edit: (items: ChangeRequestTimelineItem[]) => ChangeRequestTimelineItem[],
): void {
  queryClient.setQueryData<TimelineData>(reviewKeys.timeline(ref), (data) =>
    data ? { ...data, items: edit(data.items) } : data,
  );
}

function pendingComment(
  mutationId: string,
  body: string,
  extra: Partial<Extract<ChangeRequestTimelineItem, { kind: "comment" }>> = {},
): ChangeRequestTimelineItem {
  return {
    kind: "comment",
    id: `${PENDING_PREFIX}${mutationId}`,
    author: i18n.t("reviewScreen.write.you"),
    authorUrl: null,
    avatarUrl: null,
    body,
    createdAt: Date.now(),
    url: "",
    ...extra,
  };
}

function withThreadResolved(
  items: ChangeRequestTimelineItem[],
  threadId: string,
  resolved: boolean,
): ChangeRequestTimelineItem[] {
  return items.map((item) => {
    if (item.kind !== "comment") return item;
    const id = item.threadId ?? item.location?.threadId;
    if (id !== threadId) return item;
    return {
      ...item,
      threadIsResolved: resolved,
      ...(item.location ? { location: { ...item.location, isResolved: resolved } } : {}),
    };
  });
}

export interface CreateCommentInput {
  mutationId: string;
  body: string;
  /** A single comment on one diff line of `headSha`; absent: a comment on the conversation. */
  location?: { path: string; side: "new" | "old"; line: number; headSha: string };
}
export interface ReplyInput {
  mutationId: string;
  /** The raw forge thread id (the timeline entry id without its `thread:` prefix). */
  threadId: string;
  body: string;
}
export interface ResolveInput {
  threadId: string;
  resolved: boolean;
}
export interface SubmitReviewInput {
  mutationId: string;
  headSha: string;
  event: ReviewEvent;
  body: string;
  comments: ReviewLineComment[];
}

export interface ReviewWrites {
  createComment: (input: CreateCommentInput) => Promise<WriteResult>;
  reply: (input: ReplyInput) => Promise<WriteResult>;
  setResolved: (input: ResolveInput) => Promise<WriteResult>;
  submitReview: (input: SubmitReviewInput) => Promise<WriteResult>;
}

export function useReviewWrites(ref: ChangeRequestSource): ReviewWrites {
  const client = useHostRuntimeClient(ref.serverId);
  const queryClient = useQueryClient();
  const identity = useMemo(
    () => ({ forgeHost: ref.forgeHost, owner: ref.owner, name: ref.name, number: ref.number }),
    [ref.forgeHost, ref.name, ref.number, ref.owner],
  );
  const requireClient = useCallback(() => {
    if (!client) throw new WriteError("transport", i18n.t("reviewScreen.errors.noConnection"));
    return client;
  }, [client]);
  const settle = useCallback(
    (kinds: Array<"timeline" | "status" | "overview">) => {
      void refreshAfterWrite(queryClient, ref, kinds);
    },
    [queryClient, ref],
  );

  const createComment = useMutation({
    mutationFn: async (input: CreateCommentInput) =>
      guard(
        await requireClient().forgeChangeRequestCreateComment({
          ...identity,
          mutationId: input.mutationId,
          body: input.body,
          ...(input.location ? { location: input.location } : {}),
        }),
      ),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: reviewKeys.timeline(ref) });
      const location = input.location;
      const item = pendingComment(
        input.mutationId,
        input.body,
        location
          ? {
              threadId: `${PENDING_PREFIX}${input.mutationId}`,
              threadIsResolved: false,
              location: {
                path: location.path,
                line: location.line,
                threadId: `${PENDING_PREFIX}${input.mutationId}`,
                isResolved: false,
                isOutdated: false,
              },
            }
          : {},
      );
      editTimeline(queryClient, ref, (items) => [...items, item]);
    },
    onError: (_error, input) => {
      const id = `${PENDING_PREFIX}${input.mutationId}`;
      editTimeline(queryClient, ref, (items) => items.filter((item) => item.id !== id));
    },
    onSuccess: () => settle(["timeline"]),
  });

  const reply = useMutation({
    mutationFn: async (input: ReplyInput) =>
      guard(
        await requireClient().forgeChangeRequestReplyToThread({
          ...identity,
          mutationId: input.mutationId,
          threadId: input.threadId,
          body: input.body,
        }),
      ),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: reviewKeys.timeline(ref) });
      editTimeline(queryClient, ref, (items) => {
        const first = items.find(
          (item) =>
            item.kind === "comment" &&
            (item.threadId ?? item.location?.threadId) === input.threadId,
        );
        const root = first?.kind === "comment" ? first : null;
        return [
          ...items,
          pendingComment(input.mutationId, input.body, {
            threadId: input.threadId,
            ...(root?.threadIsResolved !== undefined
              ? { threadIsResolved: root.threadIsResolved }
              : {}),
            ...(root?.location ? { location: root.location } : {}),
            ...(root?.reviewId ? { reviewId: root.reviewId } : {}),
          }),
        ];
      });
    },
    onError: (_error, input) => {
      const id = `${PENDING_PREFIX}${input.mutationId}`;
      editTimeline(queryClient, ref, (items) => items.filter((item) => item.id !== id));
    },
    onSuccess: () => settle(["timeline"]),
  });

  const setResolved = useMutation({
    mutationFn: async (input: ResolveInput) =>
      guard(
        await requireClient().forgeChangeRequestSetThreadResolved({
          ...identity,
          // A resolve is idempotent on the forge; a retry is a fresh action.
          mutationId: newMutationId(),
          threadId: input.threadId,
          resolved: input.resolved,
        }),
      ),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: reviewKeys.timeline(ref) });
      editTimeline(queryClient, ref, (items) =>
        withThreadResolved(items, input.threadId, input.resolved),
      );
    },
    onError: (_error, input) => {
      editTimeline(queryClient, ref, (items) =>
        withThreadResolved(items, input.threadId, !input.resolved),
      );
    },
    onSuccess: () => settle(["timeline"]),
  });

  const submitReview = useMutation({
    mutationFn: async (input: SubmitReviewInput) =>
      guard(
        await requireClient().forgeChangeRequestSubmitReview({
          ...identity,
          mutationId: input.mutationId,
          headSha: input.headSha,
          event: input.event,
          body: input.body,
          comments: input.comments,
        }),
      ),
    onSuccess: () => settle(["timeline", "status", "overview"]),
  });

  const run = useCallback(
    async <T>(action: (input: T) => Promise<unknown>, input: T): Promise<WriteResult> => {
      try {
        await action(input);
        return { ok: true };
      } catch (error) {
        return { ok: false, failure: toFailure(error) };
      }
    },
    [],
  );
  const { mutateAsync: createCommentAsync } = createComment;
  const { mutateAsync: replyAsync } = reply;
  const { mutateAsync: setResolvedAsync } = setResolved;
  const { mutateAsync: submitReviewAsync } = submitReview;
  return useMemo<ReviewWrites>(
    () => ({
      createComment: (input) => run(createCommentAsync, input),
      reply: (input) => run(replyAsync, input),
      setResolved: (input) => run(setResolvedAsync, input),
      submitReview: (input) => run(submitReviewAsync, input),
    }),
    [createCommentAsync, replyAsync, run, setResolvedAsync, submitReviewAsync],
  );
}

// ---- what the page may offer ----

export interface ReviewWriteContextValue {
  ref: ChangeRequestSource;
  writes: ReviewWrites;
  /** The forge's `actions` once the overview has arrived; null until then. */
  actions: ChangeRequestOverview["actions"] | null;
  state: ChangeRequestOverview["state"] | null;
  connected: boolean;
  /** The viewer opened this pull request (approve and request changes are refused). */
  viewerIsAuthor: boolean;
  /** The commit the loaded diff is of, which a review is submitted against. */
  headSha: string | null;
}

export const ReviewWriteContext = createContext<ReviewWriteContextValue | null>(null);

/** Null on a worktree page: there is no forge to write to. */
export function useReviewWriteContext(): ReviewWriteContextValue | null {
  return useContext(ReviewWriteContext);
}
