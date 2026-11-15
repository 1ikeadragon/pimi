import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { FlowService } from "../../flow/service.js";

export interface FlowSessionOptions {
  host: { emit(msg: SessionOutboundMessage): void };
  flowService: FlowService;
  logger: pino.Logger;
}

type FlowRequest = Extract<SessionInboundMessage, { type: `flow.${string}` }>;

// Requests over a client connection come from the owner. Only `flow.create` may say it was made
// by an agent (the CLI inside an agent does), which leaves the flow waiting for approval.
const USER = { kind: "user" } as const;

export class FlowSession {
  private readonly host: FlowSessionOptions["host"];
  private readonly flows: FlowService;
  private readonly logger: pino.Logger;

  constructor(options: FlowSessionOptions) {
    this.host = options.host;
    this.flows = options.flowService;
    this.logger = options.logger;
  }

  dispatch(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "flow.list.request":
        return this.handle(msg, async () => ({
          type: "flow.list.response",
          payload: { requestId: msg.requestId, flows: await this.flows.list() },
        }));
      case "flow.get.request":
        return this.handle(msg, async () => ({
          type: "flow.get.response",
          payload: { requestId: msg.requestId, flow: await this.flows.get(msg.flowId) },
        }));
      case "flow.create.request":
        return this.handle(msg, async () => ({
          type: "flow.create.response",
          payload: {
            requestId: msg.requestId,
            flow: await this.flows.create({
              definition: msg.definition,
              origin: msg.origin ?? USER,
            }),
          },
        }));
      case "flow.update.request":
        return this.handle(msg, async () => ({
          type: "flow.update.response",
          payload: {
            requestId: msg.requestId,
            flow: await this.flows.update({ id: msg.flowId, definition: msg.definition }),
          },
        }));
      case "flow.delete.request":
        return this.handle(msg, async () => {
          await this.flows.delete(msg.flowId);
          return {
            type: "flow.delete.response",
            payload: { requestId: msg.requestId, flowId: msg.flowId },
          };
        });
      case "flow.approve.request":
        return this.handle(msg, async () => ({
          type: "flow.approve.response",
          payload: { requestId: msg.requestId, flow: await this.flows.approve(msg.flowId) },
        }));
      case "flow.run.get.request":
        return this.handle(msg, async () => ({
          type: "flow.run.get.response",
          payload: { requestId: msg.requestId, run: await this.flows.getRun(msg.runId) },
        }));
      case "flow.run.cancel.request":
        return this.handle(msg, async () => ({
          type: "flow.run.cancel.response",
          payload: { requestId: msg.requestId, run: await this.flows.cancelRun(msg.runId) },
        }));
      case "flow.run.retry.request":
        return this.handle(msg, async () => ({
          type: "flow.run.retry.response",
          payload: { requestId: msg.requestId, run: await this.flows.retryRun(msg.runId) },
        }));
      default:
        return undefined;
    }
  }

  private async handle(
    request: FlowRequest,
    respond: () => Promise<SessionOutboundMessage>,
  ): Promise<void> {
    try {
      this.host.emit(await respond());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ err: error, requestType: request.type }, "Flow request failed");
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: request.requestId,
          requestType: request.type,
          error: message,
          code: "flow_request_failed",
        },
      });
    }
  }
}
