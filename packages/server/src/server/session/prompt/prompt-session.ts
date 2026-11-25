import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { PromptService } from "../../prompt/service.js";

export interface PromptSessionOptions {
  host: { emit(msg: SessionOutboundMessage): void };
  promptService: PromptService;
  logger: pino.Logger;
}

type PromptRequest = Extract<SessionInboundMessage, { type: `prompt.${string}` }>;

export class PromptSession {
  private readonly host: PromptSessionOptions["host"];
  private readonly prompts: PromptService;
  private readonly logger: pino.Logger;

  constructor(options: PromptSessionOptions) {
    this.host = options.host;
    this.prompts = options.promptService;
    this.logger = options.logger;
  }

  dispatch(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "prompt.list.request":
        return this.handle(msg, async () => ({
          type: "prompt.list.response",
          payload: { requestId: msg.requestId, prompts: await this.prompts.list() },
        }));
      case "prompt.create.request":
        return this.handle(msg, async () => ({
          type: "prompt.create.response",
          payload: { requestId: msg.requestId, prompt: await this.prompts.create(msg.definition) },
        }));
      case "prompt.update.request":
        return this.handle(msg, async () => ({
          type: "prompt.update.response",
          payload: {
            requestId: msg.requestId,
            prompt: await this.prompts.update({
              promptId: msg.promptId,
              definition: msg.definition,
            }),
          },
        }));
      case "prompt.delete.request":
        return this.handle(msg, async () => {
          await this.prompts.delete(msg.promptId);
          return {
            type: "prompt.delete.response",
            payload: { requestId: msg.requestId, promptId: msg.promptId },
          };
        });
      default:
        return undefined;
    }
  }

  private async handle(
    request: PromptRequest,
    respond: () => Promise<SessionOutboundMessage>,
  ): Promise<void> {
    try {
      this.host.emit(await respond());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ err: error, requestType: request.type }, "Prompt request failed");
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: request.requestId,
          requestType: request.type,
          error: message,
          code: "prompt_request_failed",
        },
      });
    }
  }
}
