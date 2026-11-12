import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";

export interface ChangeRequestSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

export interface ChangeRequestSessionOptions {
  host: ChangeRequestSessionHost;
  logger: pino.Logger;
}

const NOT_IMPLEMENTED = {
  code: "unsupported",
  message: "Change request review is not implemented on this daemon yet.",
} as const;

/**
 * `forge.change_request.*` RPCs: read-only change-request data addressed by forge identity
 * (host, owner, name, number) instead of a checkout cwd.
 */
export class ChangeRequestSession {
  private readonly host: ChangeRequestSessionHost;

  constructor(options: ChangeRequestSessionOptions) {
    this.host = options.host;
  }

  async handleListInboxRequest(
    msg: Extract<SessionInboundMessage, { type: "forge.change_request.list_inbox.request" }>,
  ): Promise<void> {
    this.host.emit({
      type: "forge.change_request.list_inbox.response",
      payload: { items: [], sources: [], error: NOT_IMPLEMENTED, requestId: msg.requestId },
    });
  }

  async handleGetOverviewRequest(
    msg: Extract<SessionInboundMessage, { type: "forge.change_request.get_overview.request" }>,
  ): Promise<void> {
    this.host.emit({
      type: "forge.change_request.get_overview.response",
      payload: { overview: null, error: NOT_IMPLEMENTED, requestId: msg.requestId },
    });
  }

  async handleListFilesRequest(
    msg: Extract<SessionInboundMessage, { type: "forge.change_request.list_files.request" }>,
  ): Promise<void> {
    this.host.emit({
      type: "forge.change_request.list_files.response",
      payload: { snapshot: null, files: [], error: NOT_IMPLEMENTED, requestId: msg.requestId },
    });
  }

  async handleGetFileDiffsRequest(
    msg: Extract<SessionInboundMessage, { type: "forge.change_request.get_file_diffs.request" }>,
  ): Promise<void> {
    this.host.emit({
      type: "forge.change_request.get_file_diffs.response",
      payload: {
        headSha: msg.headSha,
        diffs: [],
        error: NOT_IMPLEMENTED,
        requestId: msg.requestId,
      },
    });
  }

  async handleGetTimelineRequest(
    msg: Extract<SessionInboundMessage, { type: "forge.change_request.get_timeline.request" }>,
  ): Promise<void> {
    this.host.emit({
      type: "forge.change_request.get_timeline.response",
      payload: { items: [], truncated: false, error: NOT_IMPLEMENTED, requestId: msg.requestId },
    });
  }

  async handleGetCheckDetailsRequest(
    msg: Extract<SessionInboundMessage, { type: "forge.change_request.get_check_details.request" }>,
  ): Promise<void> {
    this.host.emit({
      type: "forge.change_request.get_check_details.response",
      payload: { details: null, error: NOT_IMPLEMENTED, requestId: msg.requestId },
    });
  }
}
