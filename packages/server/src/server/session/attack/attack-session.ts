import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { AttackService } from "../../attack/service.js";

export interface AttackSessionOptions {
  host: { emit(msg: SessionOutboundMessage): void };
  attackService: AttackService;
  logger: pino.Logger;
}

export class AttackSession {
  private readonly host: AttackSessionOptions["host"];
  private readonly attack: AttackService;
  private readonly logger: pino.Logger;

  constructor(options: AttackSessionOptions) {
    this.host = options.host;
    this.attack = options.attackService;
    this.logger = options.logger;
  }

  dispatch(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "attack.run.start.request":
        return this.handle(msg, async () => ({
          type: "attack.run.start.response",
          payload: { requestId: msg.requestId, run: await this.attack.startRun(msg.definition) },
        }));
      case "attack.run.pause.request":
        return this.handle(msg, async () => ({
          type: "attack.run.pause.response",
          payload: { requestId: msg.requestId, run: await this.attack.pauseRun(msg.runId) },
        }));
      case "attack.run.resume.request":
        return this.handle(msg, async () => ({
          type: "attack.run.resume.response",
          payload: {
            requestId: msg.requestId,
            run: await this.attack.resumeRun(msg.runId, msg.limits),
          },
        }));
      case "attack.run.cancel.request":
        return this.handle(msg, async () => ({
          type: "attack.run.cancel.response",
          payload: { requestId: msg.requestId, run: await this.attack.cancelRun(msg.runId) },
        }));
      case "attack.run.get.request":
        return this.handle(msg, async () => ({
          type: "attack.run.get.response",
          payload: {
            requestId: msg.requestId,
            ...(await this.attack.getRunWithAudit(msg.runId)),
          },
        }));
      case "attack.run.list.request":
        return this.handle(msg, async () => ({
          type: "attack.run.list.response",
          payload: {
            requestId: msg.requestId,
            runs: await this.attack.listRuns({ workspaceId: msg.workspaceId }),
          },
        }));
      case "attack.finding.list.request":
        return this.handle(msg, async () => ({
          type: "attack.finding.list.response",
          payload: {
            requestId: msg.requestId,
            findings: await this.attack.listFindings(msg.runId),
          },
        }));
      case "attack.finding.get.request":
        return this.handle(msg, async () => ({
          type: "attack.finding.get.response",
          payload: {
            requestId: msg.requestId,
            finding: await this.attack.getFinding(msg.runId, msg.findingId),
          },
        }));
      case "attack.finding.update.request":
        return this.handle(msg, async () => ({
          type: "attack.finding.update.response",
          payload: {
            requestId: msg.requestId,
            finding: await this.attack.updateFinding({
              runId: msg.runId,
              findingId: msg.findingId,
              status: msg.status,
              fixAgentId: msg.fixAgentId,
            }),
          },
        }));
      case "attack.audit.record.request":
        return this.handle(msg, async () => {
          await this.attack.recordNavigationRefused({
            runId: msg.runId,
            agentId: msg.agentId,
            host: msg.detail,
          });
          return { type: "attack.audit.record.response", payload: { requestId: msg.requestId } };
        });
      default:
        return undefined;
    }
  }

  private async handle(
    request: Extract<SessionInboundMessage, { type: `attack.${string}` }>,
    respond: () => Promise<SessionOutboundMessage>,
  ): Promise<void> {
    try {
      this.host.emit(await respond());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ err: error, requestType: request.type }, "Attack request failed");
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: request.requestId,
          requestType: request.type,
          error: message,
          code: "attack_request_failed",
        },
      });
    }
  }
}
