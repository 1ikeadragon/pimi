import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import { ActionItemsError, type ActionItemsService } from "../../action-items/service.js";

export interface ActionItemsSessionOptions {
  host: { emit(msg: SessionOutboundMessage): void };
  service: ActionItemsService;
  logger: pino.Logger;
}

export class ActionItemsSession {
  private readonly host: ActionItemsSessionOptions["host"];
  private readonly service: ActionItemsService;
  private readonly logger: pino.Logger;

  constructor(options: ActionItemsSessionOptions) {
    this.host = options.host;
    this.service = options.service;
    this.logger = options.logger;
  }

  dispatch(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "agent.action_items.get.request":
        return this.handle(msg, async () => ({
          type: "agent.action_items.get.response",
          payload: { requestId: msg.requestId, state: await this.service.get(msg.agentId) },
        }));
      case "agent.action_items.edit.request":
        return this.handle(msg, async () => ({
          type: "agent.action_items.edit.response",
          payload: {
            requestId: msg.requestId,
            state: await this.service.edit(msg.agentId, msg.edit),
          },
        }));
      default:
        return undefined;
    }
  }

  private async handle(
    msg: { requestId: string; type: string },
    run: () => Promise<SessionOutboundMessage>,
  ): Promise<void> {
    try {
      this.host.emit(await run());
    } catch (error) {
      const known = error instanceof ActionItemsError;
      if (!known)
        this.logger.error({ err: error, requestType: msg.type }, "Action items RPC failed");
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          code: known ? error.code : "action_items_request_failed",
          error: error instanceof Error ? error.message : "Action items request failed",
        },
      });
    }
  }
}
