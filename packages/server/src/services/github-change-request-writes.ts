import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createLimiter, parseJson } from "./github-change-requests.js";
import {
  ChangeRequestReadError,
  type ChangeRequestRef,
  type ChangeRequestReviewComment,
  type ForgeService,
} from "./forge-service.js";
import type { ChangeRequestReviewEvent } from "@pimi/protocol/messages";

// Writes are rare and each one is a user decision; two at a time is plenty and bounds the queue.
const WRITE_CONCURRENCY = 2;
const WRITE_MAX_PENDING = 16;
const REJECTED_MESSAGE_MAX = 300;

const REVIEW_EVENTS: Record<ChangeRequestReviewEvent, "COMMENT" | "APPROVE" | "REQUEST_CHANGES"> = {
  comment: "COMMENT",
  approve: "APPROVE",
  request_changes: "REQUEST_CHANGES",
};

const SIDES = { new: "RIGHT", old: "LEFT" } as const;

const CommentResponseSchema = z.object({ html_url: z.string().optional() });
const ReviewResponseSchema = z.object({ html_url: z.string().optional() });
const PullHeadSchema = z.object({ head: z.object({ sha: z.string() }) });
const ReplyGraphqlSchema = z.object({
  data: z
    .object({
      addPullRequestReviewThreadReply: z
        .object({ comment: z.object({ url: z.string() }).nullable() })
        .nullable(),
    })
    .nullable()
    .optional(),
});
const ResolveGraphqlSchema = z.object({
  data: z
    .object({
      resolveReviewThread: z.object({ thread: z.object({ isResolved: z.boolean() }) }).nullable(),
      unresolveReviewThread: z.object({ thread: z.object({ isResolved: z.boolean() }) }).nullable(),
    })
    .partial()
    .nullable()
    .optional(),
});
const GraphqlErrorsSchema = z.object({
  errors: z.array(z.object({ message: z.string() })).optional(),
});
const RestErrorSchema = z.object({
  message: z.string().optional(),
  errors: z
    .array(
      z.union([
        z.string(),
        z.object({ message: z.string().optional(), field: z.string().optional() }).passthrough(),
      ]),
    )
    .optional(),
});

// Fixed strings. Every value travels as a GraphQL variable inside the JSON request body.
const REPLY_MUTATION =
  "mutation($t:ID!,$b:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t,body:$b}){comment{url}}}";
const RESOLVE_MUTATION =
  "mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}";
const UNRESOLVE_MUTATION =
  "mutation($t:ID!){unresolveReviewThread(input:{threadId:$t}){thread{isResolved}}}";

export interface GitHubChangeRequestWriterDeps {
  /** Runs `gh` against `forgeHost` and returns stdout; throws the CLI's own error type. */
  run: (args: string[], forgeHost: string) => Promise<string>;
  /** Converts a CLI failure that is not a rejected write into a wire-safe error. */
  mapError: (error: unknown, forgeHost: string) => ChangeRequestReadError;
}

export type GitHubChangeRequestWriter = Required<
  Pick<
    ForgeService,
    | "createChangeRequestComment"
    | "replyToChangeRequestThread"
    | "setChangeRequestThreadResolved"
    | "submitChangeRequestReview"
    | "changeRequestReviewEvents"
  >
>;

/**
 * Hands user text to `gh` as a JSON request body in a private temp file (`--input`). The text is
 * never in argv: argv has length limits (32,767 characters on Windows), can be re-quoted by a
 * shell on Windows, and `-F` would read a value starting with `@` as a file.
 */
async function withJsonInput<T>(payload: unknown, task: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pimi-forge-"));
  const file = join(dir, "body.json");
  try {
    await writeFile(file, JSON.stringify(payload), { mode: 0o600 });
    return await task(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function tryJson(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The forge's own explanation, taken only from a parsed JSON response and capped. */
function rejectionMessage(stdout: string | undefined): string {
  const value = tryJson(stdout);
  const rest = RestErrorSchema.safeParse(value);
  const graphql = GraphqlErrorsSchema.safeParse(value);
  const parts: string[] = [];
  if (rest.success) {
    // The first `errors` entry carries the specific reason; `message` is only the status text.
    for (const entry of (rest.data.errors ?? []).slice(0, 1)) {
      const text = typeof entry === "string" ? entry : entry.message;
      if (!text) continue;
      parts.push(typeof entry !== "string" && entry.field ? `${entry.field}: ${text}` : text);
    }
    if (parts.length === 0 && rest.data.message) parts.push(rest.data.message);
  }
  if (graphql.success && graphql.data.errors?.[0]) parts.push(graphql.data.errors[0].message);
  const message = [...new Set(parts)].join(" ").trim();
  if (!message) return "GitHub rejected the request.";
  return message.length > REJECTED_MESSAGE_MAX
    ? `${message.slice(0, REJECTED_MESSAGE_MAX - 1)}…`
    : message;
}

/** `gh api graphql` exits non-zero when the response carries `errors`; stdout still holds them. */
function hasGraphqlErrors(error: unknown): error is { stdout: string } {
  if (typeof error !== "object" || error === null || !("stdout" in error)) return false;
  if (typeof error.stdout !== "string") return false;
  const parsed = GraphqlErrorsSchema.safeParse(tryJson(error.stdout));
  return parsed.success && (parsed.data.errors?.length ?? 0) > 0;
}

function isRejection(error: unknown): error is { stdout?: string; stderr: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "stderr" in error &&
    typeof error.stderr === "string" &&
    /HTTP 422/.test(error.stderr)
  );
}

export function createGitHubChangeRequestWriter(
  deps: GitHubChangeRequestWriterDeps,
): GitHubChangeRequestWriter {
  const limit = createLimiter(WRITE_CONCURRENCY, WRITE_MAX_PENDING);

  async function gh(args: string[], forgeHost: string): Promise<string> {
    return limit(async () => {
      try {
        return await deps.run(args, forgeHost);
      } catch (error) {
        if (isRejection(error)) {
          throw new ChangeRequestReadError("rejected", rejectionMessage(error.stdout));
        }
        if (hasGraphqlErrors(error)) {
          throw new ChangeRequestReadError("rejected", rejectionMessage(error.stdout));
        }
        throw deps.mapError(error, forgeHost);
      }
    });
  }

  /** POST a JSON body to a REST path. */
  function postRest(ref: ChangeRequestRef, path: string, body: unknown): Promise<string> {
    return withJsonInput(body, (file) =>
      gh(
        ["api", "--method", "POST", `repos/${ref.owner}/${ref.name}/${path}`, "--input", file],
        ref.forgeHost,
      ),
    );
  }

  /** POST a GraphQL document with variables; a response carrying `errors` is a rejection. */
  async function graphql(
    ref: ChangeRequestRef,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<string> {
    const stdout = await withJsonInput({ query, variables }, (file) =>
      gh(["api", "graphql", "--input", file], ref.forgeHost),
    );
    const errors = GraphqlErrorsSchema.safeParse(tryJson(stdout));
    if (errors.success && (errors.data.errors?.length ?? 0) > 0) {
      throw new ChangeRequestReadError("rejected", rejectionMessage(stdout));
    }
    return stdout;
  }

  return {
    changeRequestReviewEvents: ["comment", "approve", "request_changes"],

    async createChangeRequestComment(options) {
      const { location } = options;
      const stdout = location
        ? await postRest(options, `pulls/${options.number}/comments`, {
            body: options.body,
            commit_id: location.headSha,
            path: location.path,
            line: location.line,
            side: SIDES[location.side],
          })
        : await postRest(options, `issues/${options.number}/comments`, { body: options.body });
      return {
        url: parseJson(stdout, CommentResponseSchema, "comment").html_url ?? null,
      };
    },

    async replyToChangeRequestThread(options) {
      const stdout = await graphql(options, REPLY_MUTATION, {
        t: options.threadId,
        b: options.body,
      });
      const reply = parseJson(stdout, ReplyGraphqlSchema, "reply").data
        ?.addPullRequestReviewThreadReply;
      if (!reply) throw new ChangeRequestReadError("rejected", "GitHub rejected the request.");
      return { url: reply.comment?.url ?? null };
    },

    async setChangeRequestThreadResolved(options) {
      const stdout = await graphql(
        options,
        options.resolved ? RESOLVE_MUTATION : UNRESOLVE_MUTATION,
        { t: options.threadId },
      );
      const data = parseJson(stdout, ResolveGraphqlSchema, "thread").data;
      const thread = (options.resolved ? data?.resolveReviewThread : data?.unresolveReviewThread)
        ?.thread;
      if (!thread) throw new ChangeRequestReadError("rejected", "GitHub rejected the request.");
      return { resolved: thread.isResolved };
    },

    async submitChangeRequestReview(options) {
      // An approval has to cover exactly the commit the reviewer saw.
      const live = parseJson(
        await gh(
          [
            "api",
            "--method",
            "GET",
            `repos/${options.owner}/${options.name}/pulls/${options.number}`,
          ],
          options.forgeHost,
        ),
        PullHeadSchema,
        "pull request",
      );
      if (live.head.sha !== options.headSha) {
        throw new ChangeRequestReadError(
          "stale_snapshot",
          "New commits were pushed. Reload before submitting.",
        );
      }
      const comments = options.comments.map((comment: ChangeRequestReviewComment) => ({
        path: comment.path,
        line: comment.line,
        side: SIDES[comment.side],
        body: comment.body,
      }));
      const stdout = await postRest(options, `pulls/${options.number}/reviews`, {
        commit_id: options.headSha,
        event: REVIEW_EVENTS[options.event],
        ...(options.body ? { body: options.body } : {}),
        comments,
      });
      return { url: parseJson(stdout, ReviewResponseSchema, "review").html_url ?? null };
    },
  };
}
