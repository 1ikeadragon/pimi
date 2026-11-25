import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { PromptService } from "../../prompt/service.js";

export interface PromptSessionOptions {
  host: { emit(msg: SessionOutboundMessage): void };
  promptService: PromptService;
  logger: pino.Logger;
}

type PromptRequest = Extract<SessionInboundMessage, { type: `prompt.${string}` }>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
      case "prompt.suggestions.list.request":
        return this.listSuggestions(msg);
      case "prompt.suggestions.dismiss.request":
        return this.dismissSuggestion(msg);
      default:
        return undefined;
    }
  }

  // Suggestions answer in the payload, not with an rpc_error, so the screen keeps showing the
  // saved prompts when the history cannot be read.
  private async listSuggestions(
    msg: Extract<SessionInboundMessage, { type: "prompt.suggestions.list.request" }>,
  ): Promise<void> {
    try {
      const suggestions = await this.prompts.listSuggestions({
        projectId: msg.projectId,
        position: msg.position,
        limit: msg.limit,
      });
      this.host.emit({
        type: "prompt.suggestions.list.response",
        payload: { requestId: msg.requestId, suggestions, error: null },
      });
    } catch (error) {
      this.logger.warn({ err: error }, "Prompt suggestions failed");
      this.host.emit({
        type: "prompt.suggestions.list.response",
        payload: { requestId: msg.requestId, suggestions: [], error: errorMessage(error) },
      });
    }
  }

  private async dismissSuggestion(
    msg: Extract<SessionInboundMessage, { type: "prompt.suggestions.dismiss.request" }>,
  ): Promise<void> {
    try {
      await this.prompts.dismissSuggestion({ projectId: msg.projectId, key: msg.key });
      this.host.emit({
        type: "prompt.suggestions.dismiss.response",
        payload: { requestId: msg.requestId, error: null },
      });
    } catch (error) {
      this.logger.warn({ err: error }, "Prompt suggestion dismissal failed");
      this.host.emit({
        type: "prompt.suggestions.dismiss.response",
        payload: { requestId: msg.requestId, error: errorMessage(error) },
      });
    }
  }

  private async handle(
    request: PromptRequest,
    respond: () => Promise<SessionOutboundMessage>,
  ): Promise<void> {
    try {
      this.host.emit(await respond());
    } catch (error) {
      const message = errorMessage(error);
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
