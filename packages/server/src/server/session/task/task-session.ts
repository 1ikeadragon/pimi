import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { OwnedSubscription } from "../owned-subscriptions/index.js";
import { LabelError, type LabelService } from "../../labels/service.js";
import { TaskError, type TaskService } from "../../task/service.js";

export interface TaskSessionOptions {
  host: {
    emit(msg: SessionOutboundMessage): void;
    beginSubscription(family: string, stop: () => void): OwnedSubscription;
  };
  taskService: TaskService;
  labelService: LabelService;
  logger: pino.Logger;
}

type Request<T extends SessionInboundMessage["type"]> = Extract<SessionInboundMessage, { type: T }>;

// Task and label RPCs. Requests over a client connection come from the owner (ordinary session
// auth), so a task made here is `createdBy: "user"`.
export class TaskSession {
  private readonly host: TaskSessionOptions["host"];
  private readonly tasks: TaskService;
  private readonly labels: LabelService;
  private readonly logger: pino.Logger;

  constructor(options: TaskSessionOptions) {
    this.host = options.host;
    this.tasks = options.taskService;
    this.labels = options.labelService;
    this.logger = options.logger;
  }

  dispatch(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "task.list.request":
        return this.handle(msg, async () => ({
          type: "task.list.response",
          payload: { requestId: msg.requestId, tasks: await this.tasks.list() },
        }));
      case "task.get.request":
        return this.handle(msg, async () => ({
          type: "task.get.response",
          payload: { requestId: msg.requestId, task: await this.tasks.get(msg.taskId) },
        }));
      case "task.create.request":
        return this.handle(msg, async () => {
          const { labelIds, links, ...fields } = msg.task;
          const result = await this.tasks.create({
            ...fields,
            ...(labelIds ? { labelIds } : {}),
            ...(links ? { links } : {}),
            createdBy: "user",
          });
          return { type: "task.create.response", payload: { requestId: msg.requestId, ...result } };
        });
      case "task.update.request":
        return this.handle(msg, async () => ({
          type: "task.update.response",
          payload: {
            requestId: msg.requestId,
            task: await this.tasks.update(msg.taskId, msg.update),
          },
        }));
      case "task.delete.request":
        return this.handle(msg, async () => {
          await this.tasks.delete(msg.taskId);
          return {
            type: "task.delete.response",
            payload: { requestId: msg.requestId, taskId: msg.taskId },
          };
        });
      case "task.link.set.request":
        return this.handle(msg, async () => ({
          type: "task.link.set.response",
          payload: {
            requestId: msg.requestId,
            task: await this.tasks.setLink(msg.taskId, msg.target, msg.linked),
          },
        }));
      case "task.import.request":
        return this.handle(msg, async () => ({
          type: "task.import.response",
          payload: { requestId: msg.requestId, ...(await this.tasks.import(msg.tasks)) },
        }));
      case "label.list.request":
        return this.handleLabelList(msg);
      case "label.create.request":
        return this.handle(msg, async () => ({
          type: "label.create.response",
          payload: {
            requestId: msg.requestId,
            label: this.labels.create({ name: msg.name, color: msg.color }),
          },
        }));
      case "label.update.request":
        return this.handle(msg, async () => ({
          type: "label.update.response",
          payload: {
            requestId: msg.requestId,
            label: this.labels.update({
              labelId: msg.labelId,
              ...(msg.name !== undefined ? { name: msg.name } : {}),
              ...(msg.color !== undefined ? { color: msg.color } : {}),
            }),
          },
        }));
      case "label.delete.request":
        return this.handle(msg, async () => ({
          type: "label.delete.response",
          payload: {
            requestId: msg.requestId,
            labelId: msg.labelId,
            affectedCount: this.labels.delete(msg.labelId),
          },
        }));
      case "label.delete.inspect.request":
        return this.handle(msg, async () => ({
          type: "label.delete.inspect.response",
          payload: {
            requestId: msg.requestId,
            labelId: msg.labelId,
            affectedCount: this.labels.countAffected(msg.labelId),
          },
        }));
      case "label.assignment.set.request":
        return this.handle(msg, async () => ({
          type: "label.assignment.set.response",
          payload: {
            requestId: msg.requestId,
            target: msg.target,
            labelIds: await this.labels.setAssignment({
              target: msg.target,
              labelId: msg.labelId,
              assigned: msg.assigned,
            }),
          },
        }));
      default:
        return undefined;
    }
  }

  private async handleLabelList(msg: Request<"label.list.request">): Promise<void> {
    if (!msg.subscribe) {
      this.host.emit({
        type: "label.list.response",
        payload: { requestId: msg.requestId, ...this.labels.list() },
      });
      return;
    }
    let unsubscribe: (() => void) | undefined;
    const owner = this.host.beginSubscription("labels", () => unsubscribe?.());
    try {
      // Subscribe and snapshot in one synchronous step: no change can land between them.
      unsubscribe = this.labels.subscribe((change) => {
        if (owner.signal.aborted) return;
        owner.emit({ type: "label.update", payload: change });
      });
      const snapshot = this.labels.list();
      this.host.emit({
        type: "label.list.response",
        payload: { requestId: msg.requestId, subscriptionId: owner.id, ...snapshot },
      });
    } catch (error) {
      await owner.release();
      this.fail(msg, error);
    }
  }

  private async handle<T extends SessionInboundMessage & { requestId: string }>(
    msg: T,
    run: () => Promise<SessionOutboundMessage>,
  ): Promise<void> {
    try {
      this.host.emit(await run());
    } catch (error) {
      this.fail(msg, error);
    }
  }

  private fail(msg: { requestId: string; type: string }, error: unknown): void {
    const known = error instanceof TaskError || error instanceof LabelError;
    if (!known) this.logger.error({ err: error, requestType: msg.type }, "Task RPC failed");
    this.host.emit({
      type: "rpc_error",
      payload: {
        requestId: msg.requestId,
        requestType: msg.type,
        code: known ? error.code : "task_request_failed",
        error: error instanceof Error ? error.message : "Task request failed",
      },
    });
  }
}
