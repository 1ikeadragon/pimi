import type pino from "pino";
import { LRUCache } from "lru-cache";
import { normalizeHost } from "@pimi/protocol/git-remote";
import {
  ChangeRequestBodySchema,
  ChangeRequestForgeHostSchema,
  ChangeRequestHeadShaSchema,
  ChangeRequestLineLocationSchema,
  ChangeRequestNumberSchema,
  ChangeRequestRepoSegmentSchema,
  ChangeRequestThreadIdSchema,
  type ChangeRequestActions,
  type ChangeRequestError,
  type SessionInboundMessage,
  type SessionOutboundMessage,
} from "../../messages.js";
import {
  ChangeRequestReadError,
  type ChangeRequestRef,
  type ForgeService,
} from "../../../services/forge-service.js";
import type { WorkspaceGitService } from "../../workspace-git-service.js";

export interface ChangeRequestSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

export interface ChangeRequestSessionOptions {
  host: ChangeRequestSessionHost;
  workspaceGitService: Pick<WorkspaceGitService, "resolveForgeForHost">;
  logger: pino.Logger;
}

interface RefFields {
  forgeHost: string;
  owner: string;
  name: string;
  number: number;
}

const DEFAULT_INBOX_LIMIT = 50;
// A repeated `mutationId` inside this window returns the first result instead of writing again.
const MUTATION_CACHE_MAX = 200;
const MUTATION_CACHE_TTL_MS = 10 * 60 * 1000;

type WriteMessage = RefFields & { type: string; mutationId: string };

/**
 * `forge.change_request.*` RPCs: read-only change-request data addressed by forge identity
 * (host, owner, name, number) instead of a checkout cwd. The schema already validated the shape;
 * identity is checked again here because it reaches a CLI argument list, and the host must resolve
 * to a cloud forge or one the forge CLI is already authenticated to.
 */
export class ChangeRequestSession {
  private readonly host: ChangeRequestSessionHost;
  private readonly workspaceGitService: Pick<WorkspaceGitService, "resolveForgeForHost">;
  private readonly logger: pino.Logger;
  private readonly mutations = new LRUCache<string, Promise<unknown>>({
    max: MUTATION_CACHE_MAX,
    ttl: MUTATION_CACHE_TTL_MS,
  });

  constructor(options: ChangeRequestSessionOptions) {
    this.host = options.host;
    this.workspaceGitService = options.workspaceGitService;
    this.logger = options.logger.child({ module: "change-request" });
  }

  private toWireError(error: unknown, operation: string): ChangeRequestError {
    if (error instanceof ChangeRequestReadError) {
      return { code: error.code, message: error.message };
    }
    // Unclassified failures are logged with detail and shown without it: CLI errors can carry
    // credentials or remote response text.
    this.logger.warn({ err: error, operation }, "Change request operation failed");
    return { code: "unavailable", message: "The change request could not be read or updated." };
  }

  private validateHost(forgeHost: string): string {
    if (!ChangeRequestForgeHostSchema.safeParse(forgeHost).success) {
      throw new ChangeRequestReadError("invalid_request", "Invalid forge host.");
    }
    return normalizeHost(forgeHost);
  }

  private validateRef(input: RefFields): ChangeRequestRef {
    if (
      !ChangeRequestRepoSegmentSchema.safeParse(input.owner).success ||
      !ChangeRequestRepoSegmentSchema.safeParse(input.name).success ||
      !ChangeRequestNumberSchema.safeParse(input.number).success
    ) {
      throw new ChangeRequestReadError("invalid_request", "Invalid change request identity.");
    }
    return {
      forgeHost: this.validateHost(input.forgeHost),
      owner: input.owner,
      name: input.name,
      number: input.number,
    };
  }

  private async resolveService(forgeHost: string): Promise<ForgeService> {
    const resolution = await this.workspaceGitService.resolveForgeForHost(forgeHost);
    if (!resolution) {
      throw new ChangeRequestReadError(
        "unsupported",
        `${forgeHost} is not a supported forge host, or its CLI is not signed in to it.`,
      );
    }
    return resolution.service;
  }

  private unsupported(forge: string): ChangeRequestReadError {
    return new ChangeRequestReadError(
      "unsupported",
      `Reviewing ${forge} change requests without a checkout is not supported yet.`,
    );
  }

  async handleListInboxRequest(
    msg: Extract<SessionInboundMessage, { type: "forge.change_request.list_inbox.request" }>,
  ): Promise<void> {
    try {
      const forgeHost = this.validateHost(msg.forgeHost);
      const repositories = (msg.repositories ?? []).map((repository) => {
        const ref = this.validateRef({ forgeHost, ...repository, number: 1 });
        return { owner: ref.owner, name: ref.name };
      });
      const service = await this.resolveService(forgeHost);
      if (!service.listChangeRequestInbox) {
        throw this.unsupported(forgeHost);
      }
      const inbox = await service.listChangeRequestInbox({
        forgeHost,
        scopes: msg.scopes,
        repositories,
        limit: msg.limit ?? DEFAULT_INBOX_LIMIT,
        force: msg.refresh,
      });
      this.host.emit({
        type: "forge.change_request.list_inbox.response",
        payload: { ...inbox, error: null, requestId: msg.requestId },
      });
    } catch (error) {
      this.host.emit({
        type: "forge.change_request.list_inbox.response",
        payload: {
          items: [],
          sources: [],
          error: this.toWireError(error, "list_inbox"),
          requestId: msg.requestId,
        },
      });
    }
  }

  private async withService<T>(
    msg: RefFields & { refresh?: boolean },
    pick: (
      service: ForgeService,
    ) => ((input: ChangeRequestRef & { force?: boolean }) => Promise<T>) | undefined,
  ): Promise<T> {
    const ref = this.validateRef(msg);
    const service = await this.resolveService(ref.forgeHost);
    const read = pick(service);
    if (!read) {
      throw this.unsupported(ref.forgeHost);
    }
    return read.call(service, { ...ref, force: msg.refresh });
  }

  async handleGetOverviewRequest(
    msg: Extract<SessionInboundMessage, { type: "forge.change_request.get_overview.request" }>,
  ): Promise<void> {
    try {
      const ref = this.validateRef(msg);
      const service = await this.resolveService(ref.forgeHost);
      if (!service.getChangeRequestOverview) throw this.unsupported(ref.forgeHost);
      const overview = await service.getChangeRequestOverview({ ...ref, force: msg.refresh });
      this.host.emit({
        type: "forge.change_request.get_overview.response",
        payload: {
          overview: { ...overview, actions: actionsOf(service) },
          error: null,
          requestId: msg.requestId,
        },
      });
    } catch (error) {
      this.host.emit({
        type: "forge.change_request.get_overview.response",
        payload: {
          overview: null,
          error: this.toWireError(error, "get_overview"),
          requestId: msg.requestId,
        },
      });
    }
  }

  /**
   * Shared path of the four writes: re-check identity, resolve the trusted service, run the
   * adapter once per `mutationId`. A failed run is forgotten so a retry with the same id runs
   * again; a successful one is remembered so a retry after a timeout cannot write twice. The body
   * is never logged.
   */
  private async write<T>(
    msg: WriteMessage,
    operation: string,
    execute: (service: ForgeService, ref: ChangeRequestRef) => Promise<T> | undefined,
  ): Promise<T> {
    const ref = this.validateRef(msg);
    const service = await this.resolveService(ref.forgeHost);
    const key = `${msg.type}:${msg.mutationId}`;
    const existing = this.mutations.get(key);
    if (existing) {
      this.logger.info({ operation, ref, outcome: "duplicate" }, "Change request write");
      return existing as Promise<T>;
    }
    const pending = execute(service, ref);
    if (!pending) throw this.unsupported(ref.forgeHost);
    this.mutations.set(key, pending);
    pending.then(
      () => this.logger.info({ operation, ref, outcome: "ok" }, "Change request write"),
      (error: unknown) => {
        this.mutations.delete(key);
        const code = error instanceof ChangeRequestReadError ? error.code : "unavailable";
        this.logger.info({ operation, ref, outcome: code }, "Change request write");
      },
    );
    return pending;
  }

  private requireBody(body: string): string {
    if (!ChangeRequestBodySchema.safeParse(body).success || body.trim() === "") {
      throw new ChangeRequestReadError("invalid_request", "The comment is empty or too long.");
    }
    return body;
  }

  private requireThreadId(threadId: string): string {
    if (!ChangeRequestThreadIdSchema.safeParse(threadId).success) {
      throw new ChangeRequestReadError("invalid_request", "Invalid conversation id.");
    }
    return threadId;
  }

  private requireHeadSha(headSha: string): string {
    if (!ChangeRequestHeadShaSchema.safeParse(headSha).success) {
      throw new ChangeRequestReadError("invalid_request", "Invalid revision.");
    }
    return headSha;
  }

  private requireLocation<L extends { path: string; side: "new" | "old"; line: number }>(
    location: L,
  ): L {
    if (!ChangeRequestLineLocationSchema.safeParse(location).success) {
      throw new ChangeRequestReadError("invalid_request", "Invalid comment location.");
    }
    return location;
  }

  async handleCreateCommentRequest(
    msg: Extract<SessionInboundMessage, { type: "forge.change_request.create_comment.request" }>,
  ): Promise<void> {
    try {
      const body = this.requireBody(msg.body);
      const location = msg.location
        ? {
            ...this.requireLocation(msg.location),
            headSha: this.requireHeadSha(msg.location.headSha),
          }
        : undefined;
      const result = await this.write(msg, "create_comment", (service, ref) =>
        service.createChangeRequestComment?.({ ...ref, body, ...(location ? { location } : {}) }),
      );
      this.host.emit({
        type: "forge.change_request.create_comment.response",
        payload: { url: result.url, error: null, requestId: msg.requestId },
      });
    } catch (error) {
      this.host.emit({
        type: "forge.change_request.create_comment.response",
        payload: {
          url: null,
          error: this.toWireError(error, "create_comment"),
          requestId: msg.requestId,
        },
      });
    }
  }

  async handleReplyToThreadRequest(
    msg: Extract<SessionInboundMessage, { type: "forge.change_request.reply_to_thread.request" }>,
  ): Promise<void> {
    try {
      const body = this.requireBody(msg.body);
      const threadId = this.requireThreadId(msg.threadId);
      const result = await this.write(msg, "reply_to_thread", (service, ref) =>
        service.replyToChangeRequestThread?.({ ...ref, threadId, body }),
      );
      this.host.emit({
        type: "forge.change_request.reply_to_thread.response",
        payload: { url: result.url, error: null, requestId: msg.requestId },
      });
    } catch (error) {
      this.host.emit({
        type: "forge.change_request.reply_to_thread.response",
        payload: {
          url: null,
          error: this.toWireError(error, "reply_to_thread"),
          requestId: msg.requestId,
        },
      });
    }
  }

  async handleSetThreadResolvedRequest(
    msg: Extract<
      SessionInboundMessage,
      { type: "forge.change_request.set_thread_resolved.request" }
    >,
  ): Promise<void> {
    try {
      const threadId = this.requireThreadId(msg.threadId);
      const result = await this.write(msg, "set_thread_resolved", (service, ref) =>
        service.setChangeRequestThreadResolved?.({ ...ref, threadId, resolved: msg.resolved }),
      );
      this.host.emit({
        type: "forge.change_request.set_thread_resolved.response",
        payload: { resolved: result.resolved, error: null, requestId: msg.requestId },
      });
    } catch (error) {
      this.host.emit({
        type: "forge.change_request.set_thread_resolved.response",
        payload: {
          resolved: null,
          error: this.toWireError(error, "set_thread_resolved"),
          requestId: msg.requestId,
        },
      });
    }
  }

  async handleSubmitReviewRequest(
    msg: Extract<SessionInboundMessage, { type: "forge.change_request.submit_review.request" }>,
  ): Promise<void> {
    try {
      const headSha = this.requireHeadSha(msg.headSha);
      const comments = msg.comments.map((comment) => ({
        ...this.requireLocation(comment),
        body: this.requireBody(comment.body),
      }));
      const hasBody = msg.body.trim() !== "";
      // GitHub refuses an empty comment or change request; fail here with a sentence instead.
      if (msg.event !== "approve" && !hasBody && comments.length === 0) {
        throw new ChangeRequestReadError(
          "invalid_request",
          "Add a summary or at least one line comment.",
        );
      }
      const result = await this.write(msg, "submit_review", (service, ref) => {
        if (!service.changeRequestReviewEvents?.includes(msg.event)) return undefined;
        return service.submitChangeRequestReview?.({
          ...ref,
          headSha,
          event: msg.event,
          body: msg.body,
          comments,
        });
      });
      this.host.emit({
        type: "forge.change_request.submit_review.response",
        payload: { url: result.url, error: null, requestId: msg.requestId },
      });
    } catch (error) {
      this.host.emit({
        type: "forge.change_request.submit_review.response",
        payload: {
          url: null,
          error: this.toWireError(error, "submit_review"),
          requestId: msg.requestId,
        },
      });
    }
  }

  async handleGetStatusRequest(
    msg: Extract<SessionInboundMessage, { type: "forge.change_request.get_status.request" }>,
  ): Promise<void> {
    try {
      const status = await this.withService(msg, (s) => s.getChangeRequestStatus);
      this.host.emit({
        type: "forge.change_request.get_status.response",
        payload: { status, error: null, requestId: msg.requestId },
      });
    } catch (error) {
      this.host.emit({
        type: "forge.change_request.get_status.response",
        payload: {
          status: null,
          error: this.toWireError(error, "get_status"),
          requestId: msg.requestId,
        },
      });
    }
  }

  async handleListCommitsRequest(
    msg: Extract<SessionInboundMessage, { type: "forge.change_request.list_commits.request" }>,
  ): Promise<void> {
    try {
      const list = await this.withService(msg, (s) => s.listChangeRequestCommits);
      this.host.emit({
        type: "forge.change_request.list_commits.response",
        payload: { ...list, error: null, requestId: msg.requestId },
      });
    } catch (error) {
      this.host.emit({
        type: "forge.change_request.list_commits.response",
        payload: {
          commits: [],
          truncated: false,
          error: this.toWireError(error, "list_commits"),
          requestId: msg.requestId,
        },
      });
    }
  }

  async handleListFilesRequest(
    msg: Extract<SessionInboundMessage, { type: "forge.change_request.list_files.request" }>,
  ): Promise<void> {
    try {
      const list = await this.withService(msg, (s) => s.listChangeRequestFiles);
      this.host.emit({
        type: "forge.change_request.list_files.response",
        payload: { ...list, error: null, requestId: msg.requestId },
      });
    } catch (error) {
      this.host.emit({
        type: "forge.change_request.list_files.response",
        payload: {
          snapshot: null,
          files: [],
          error: this.toWireError(error, "list_files"),
          requestId: msg.requestId,
        },
      });
    }
  }

  async handleGetFileDiffsRequest(
    msg: Extract<SessionInboundMessage, { type: "forge.change_request.get_file_diffs.request" }>,
  ): Promise<void> {
    try {
      if (!ChangeRequestHeadShaSchema.safeParse(msg.headSha).success) {
        throw new ChangeRequestReadError("invalid_request", "Invalid head revision.");
      }
      const result = await this.withService(msg, (s) =>
        s.getChangeRequestFileDiffs
          ? (input) =>
              s.getChangeRequestFileDiffs!({ ...input, headSha: msg.headSha, paths: msg.paths })
          : undefined,
      );
      this.host.emit({
        type: "forge.change_request.get_file_diffs.response",
        payload: { ...result, error: null, requestId: msg.requestId },
      });
    } catch (error) {
      this.host.emit({
        type: "forge.change_request.get_file_diffs.response",
        payload: {
          headSha: msg.headSha,
          diffs: [],
          error: this.toWireError(error, "get_file_diffs"),
          requestId: msg.requestId,
        },
      });
    }
  }

  async handleGetTimelineRequest(
    msg: Extract<SessionInboundMessage, { type: "forge.change_request.get_timeline.request" }>,
  ): Promise<void> {
    try {
      const timeline = await this.withService(msg, (s) => s.getChangeRequestTimeline);
      if (timeline.error) {
        const code = timeline.error.kind === "unknown" ? "unavailable" : timeline.error.kind;
        throw new ChangeRequestReadError(
          code,
          code === "unavailable"
            ? "The discussion could not be read."
            : "The discussion is not available to your account.",
        );
      }
      this.host.emit({
        type: "forge.change_request.get_timeline.response",
        payload: {
          items: timeline.items,
          truncated: timeline.truncated,
          error: null,
          requestId: msg.requestId,
        },
      });
    } catch (error) {
      this.host.emit({
        type: "forge.change_request.get_timeline.response",
        payload: {
          items: [],
          truncated: false,
          error: this.toWireError(error, "get_timeline"),
          requestId: msg.requestId,
        },
      });
    }
  }

  async handleGetCheckDetailsRequest(
    msg: Extract<SessionInboundMessage, { type: "forge.change_request.get_check_details.request" }>,
  ): Promise<void> {
    try {
      if (msg.checkRunId === undefined && msg.workflowRunId === undefined) {
        throw new ChangeRequestReadError(
          "invalid_request",
          "Check details need a check run id or workflow run id.",
        );
      }
      const details = await this.withService(msg, (s) =>
        s.getChangeRequestCheckDetails
          ? (input) =>
              s.getChangeRequestCheckDetails!({
                ...input,
                checkRunId: msg.checkRunId,
                workflowRunId: msg.workflowRunId,
              })
          : undefined,
      );
      this.host.emit({
        type: "forge.change_request.get_check_details.response",
        payload: { details, error: null, requestId: msg.requestId },
      });
    } catch (error) {
      this.host.emit({
        type: "forge.change_request.get_check_details.response",
        payload: {
          details: null,
          error: this.toWireError(error, "get_check_details"),
          requestId: msg.requestId,
        },
      });
    }
  }
}

/** What the UI may offer: derived from which optional write methods the adapter implements. */
function actionsOf(service: ForgeService): ChangeRequestActions {
  return {
    comment: service.createChangeRequestComment !== undefined,
    lineComment: service.createChangeRequestComment !== undefined,
    reply: service.replyToChangeRequestThread !== undefined,
    resolve: service.setChangeRequestThreadResolved !== undefined,
    reviewEvents: service.submitChangeRequestReview
      ? [...(service.changeRequestReviewEvents ?? [])]
      : [],
  };
}
