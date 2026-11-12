import type pino from "pino";
import { normalizeHost } from "@pimi/protocol/git-remote";
import {
  ChangeRequestForgeHostSchema,
  ChangeRequestHeadShaSchema,
  ChangeRequestNumberSchema,
  ChangeRequestRepoSegmentSchema,
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
    this.logger.warn({ err: error, operation }, "Change request read failed");
    return { code: "unavailable", message: "The change request could not be read." };
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
      const overview = await this.withService(msg, (s) => s.getChangeRequestOverview);
      this.host.emit({
        type: "forge.change_request.get_overview.response",
        payload: { overview, error: null, requestId: msg.requestId },
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
