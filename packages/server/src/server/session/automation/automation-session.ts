import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { AutomationService } from "../../automation/service.js";
import type { HeartbeatService } from "../../heartbeat/service.js";

export interface AutomationSessionOptions {
  host: { emit(msg: SessionOutboundMessage): void };
  automationService: AutomationService;
  heartbeatService: HeartbeatService;
  logger: pino.Logger;
}

type Request<T extends SessionInboundMessage["type"]> = Extract<SessionInboundMessage, { type: T }>;

// Requests over a client connection come from the owner. Only `automation.create` and
// `automation.update` may say they were made by an agent (the CLI inside an agent does), which
// leaves the automation waiting for approval.
const USER = { kind: "user" } as const;

export class AutomationSession {
  private readonly host: AutomationSessionOptions["host"];
  private readonly automations: AutomationService;
  private readonly heartbeats: HeartbeatService;
  private readonly logger: pino.Logger;

  constructor(options: AutomationSessionOptions) {
    this.host = options.host;
    this.automations = options.automationService;
    this.heartbeats = options.heartbeatService;
    this.logger = options.logger;
  }

  dispatch(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "automation.create.request":
        return this.handle(msg, async () => ({
          type: "automation.create.response",
          payload: {
            requestId: msg.requestId,
            automation: await this.automations.create({
              definition: msg.definition,
              origin: msg.origin ?? USER,
            }),
          },
        }));
      case "automation.get.request":
        return this.handle(msg, async () => ({
          type: "automation.get.response",
          payload: {
            requestId: msg.requestId,
            ...(await this.automations.getWithAudit(msg.automationId)),
          },
        }));
      case "automation.list.request":
        return this.handle(msg, async () => ({
          type: "automation.list.response",
          payload: { requestId: msg.requestId, automations: await this.automations.list() },
        }));
      case "automation.update.request":
        return this.handle(msg, async () => ({
          type: "automation.update.response",
          payload: {
            requestId: msg.requestId,
            automation: await this.automations.update({
              id: msg.automationId,
              definition: msg.definition,
              actor: msg.origin?.kind === "agent" ? msg.origin : USER,
            }),
          },
        }));
      case "automation.run.retry.request":
        return this.handle(msg, async () => ({
          type: "automation.run.retry.response",
          payload: {
            requestId: msg.requestId,
            run: await this.automations.retryRun(msg.automationId, msg.runId, USER),
          },
        }));
      case "automation.compile.request":
        return this.handle(msg, async () => ({
          type: "automation.compile.response",
          payload: {
            requestId: msg.requestId,
            definition: await this.automations.compile({
              description: msg.description,
              cwd: msg.cwd,
            }),
          },
        }));
      case "automation.trigger.check.request":
        return this.handle(msg, async () => ({
          type: "automation.trigger.check.response",
          payload: {
            requestId: msg.requestId,
            ...(await this.automations.checkTrigger(msg.automationId)),
          },
        }));
      case "automation.delete.request":
        return this.handle(msg, async () => {
          await this.automations.delete(msg.automationId, USER);
          return {
            type: "automation.delete.response",
            payload: { requestId: msg.requestId, automationId: msg.automationId },
          };
        });
      case "automation.enable.request":
        return this.handle(msg, async () => ({
          type: "automation.enable.response",
          payload: {
            requestId: msg.requestId,
            automation: await this.automations.enable(msg.automationId, USER),
          },
        }));
      case "automation.pause.request":
        return this.handle(msg, async () => ({
          type: "automation.pause.response",
          payload: {
            requestId: msg.requestId,
            automation: await this.automations.pause(msg.automationId, USER),
          },
        }));
      case "automation.approve.request":
        return this.handle(msg, async () => ({
          type: "automation.approve.response",
          payload: {
            requestId: msg.requestId,
            automation: await this.automations.approve(msg.automationId, USER),
          },
        }));
      case "automation.run.start.request":
        return this.handle(msg, async () => ({
          type: "automation.run.start.response",
          payload: {
            requestId: msg.requestId,
            run: await this.automations.startManualRun(msg.automationId, USER),
          },
        }));
      case "automation.run.cancel.request":
        return this.handle(msg, async () => ({
          type: "automation.run.cancel.response",
          payload: {
            requestId: msg.requestId,
            run: await this.automations.cancelRun(msg.automationId, msg.runId),
          },
        }));
      case "automation.run.list.request":
        return this.handle(msg, async () => ({
          type: "automation.run.list.response",
          payload: {
            requestId: msg.requestId,
            runs: await this.automations.listRuns({
              automationId: msg.automationId,
              limit: msg.limit,
            }),
          },
        }));
      case "automation.run.get.request":
        return this.handle(msg, async () => ({
          type: "automation.run.get.response",
          payload: {
            requestId: msg.requestId,
            run: await this.automations.getRun(msg.automationId, msg.runId),
          },
        }));
      case "automation.run.mark_read.request":
        return this.handle(msg, async () => ({
          type: "automation.run.mark_read.response",
          payload: {
            requestId: msg.requestId,
            run: await this.automations.markRunRead(msg.automationId, msg.runId),
          },
        }));
      default:
        return this.dispatchHeartbeat(msg);
    }
  }

  private dispatchHeartbeat(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "heartbeat.create.request":
        return this.handle(msg, async () => ({
          type: "heartbeat.create.response",
          payload: {
            requestId: msg.requestId,
            heartbeat: await this.heartbeats.createOrReplace({
              agentId: msg.agentId,
              name: msg.name,
              prompt: msg.prompt,
              cadence: msg.cadence,
              maxRuns: msg.maxRuns,
              expiresAt: msg.expiresAt,
              runOnCreate: msg.runOnCreate,
            }),
          },
        }));
      case "heartbeat.update.request":
        return this.handle(msg, async () => ({
          type: "heartbeat.update.response",
          payload: {
            requestId: msg.requestId,
            heartbeat: await this.heartbeats.updateCadence(msg.heartbeatId, msg.cadence),
          },
        }));
      case "heartbeat.delete.request":
        return this.handle(msg, async () => {
          await this.heartbeats.delete(msg.heartbeatId);
          return {
            type: "heartbeat.delete.response",
            payload: { requestId: msg.requestId, heartbeatId: msg.heartbeatId },
          };
        });
      case "heartbeat.list.request":
        return this.handle(msg, async () => ({
          type: "heartbeat.list.response",
          payload: {
            requestId: msg.requestId,
            heartbeats: await this.heartbeats.list(msg.agentId),
          },
        }));
      default:
        return this.dispatchDraft(msg);
    }
  }

  // Describing an automation: drafts compile in the background on the service.
  private dispatchDraft(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "automation.draft.start.request":
        return this.handle(msg, async () => ({
          type: "automation.draft.start.response",
          payload: {
            requestId: msg.requestId,
            draft: await this.automations.startDraft({
              description: msg.description,
              cwd: msg.cwd,
            }),
          },
        }));
      case "automation.draft.list.request":
        return this.handle(msg, async () => ({
          type: "automation.draft.list.response",
          payload: { requestId: msg.requestId, drafts: await this.automations.listDrafts() },
        }));
      case "automation.draft.retry.request":
        return this.handle(msg, async () => ({
          type: "automation.draft.retry.response",
          payload: {
            requestId: msg.requestId,
            draft: await this.automations.retryDraft(msg.draftId),
          },
        }));
      case "automation.draft.dismiss.request":
        return this.handle(msg, async () => {
          await this.automations.dismissDraft(msg.draftId);
          return {
            type: "automation.draft.dismiss.response",
            payload: { requestId: msg.requestId, draftId: msg.draftId },
          };
        });
      default:
        return undefined;
    }
  }

  private async handle(
    request: Request<
      Extract<SessionInboundMessage["type"], `automation.${string}` | `heartbeat.${string}`>
    >,
    respond: () => Promise<SessionOutboundMessage>,
  ): Promise<void> {
    try {
      this.host.emit(await respond());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ err: error, requestType: request.type }, "Automation request failed");
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: request.requestId,
          requestType: request.type,
          error: message,
          code: request.type.startsWith("heartbeat.")
            ? "heartbeat_request_failed"
            : "automation_request_failed",
        },
      });
    }
  }
}
