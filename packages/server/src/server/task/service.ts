import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { LabelTarget } from "@pimi/protocol/labels";
import {
  TaskSchema,
  type Task,
  type TaskCreatedBy,
  type TaskImportRecord,
  type TaskLink,
  type TaskLinkTarget,
  type TaskStatus,
  type TaskUpdateInput,
} from "@pimi/protocol/task/types";
import type { PimiDatabase } from "../db/pimi-db.js";
import { SqlRecordStore } from "../db/sql-record-store.js";
import type { LabelService } from "../labels/service.js";

export class TaskError extends Error {
  constructor(
    readonly code: "task_not_found" | "agent_not_found",
    message: string,
  ) {
    super(message);
    this.name = "TaskError";
  }
}

export interface TaskCreateOptions {
  title: string;
  description?: string;
  status?: TaskStatus;
  labelIds?: readonly string[];
  links?: readonly TaskLink[];
  createdBy: TaskCreatedBy;
}

function linkKey(link: TaskLinkTarget): string {
  return link.kind === "agent"
    ? `agent:${link.agentId}`
    : `subagent:${link.parentAgentId}:${link.subagentId}`;
}

function titleKey(title: string): string {
  return title.replace(/\s+/g, " ").trim().toLowerCase();
}

function describeSourceAgent(links: readonly TaskLink[]): string | null {
  const link = links.find((entry) => entry.role === "creator") ?? links[0];
  if (!link) return null;
  return link.kind === "agent" ? link.agentId : link.parentAgentId;
}

// Tasks are `task` rows in pimi.db. Labels live in the label assignment store under
// `{ kind: "task", taskId }`, never on the record.
export class TaskService {
  private readonly store: SqlRecordStore<Task>;
  private readonly labels: LabelService;
  private readonly logger: Logger;
  private readonly agentExists: (agentId: string) => Promise<boolean>;
  // Resolves to the generated description, or null when there is no source material.
  private readonly describe: (input: { title: string; agentId: string }) => Promise<string | null>;
  private readonly listeners = new Set<() => void>();

  constructor(options: {
    database: PimiDatabase;
    labels: LabelService;
    logger: Logger;
    agentExists: (agentId: string) => Promise<boolean>;
    describe: (input: { title: string; agentId: string }) => Promise<string | null>;
  }) {
    this.labels = options.labels;
    this.logger = options.logger.child({ module: "tasks" });
    this.agentExists = options.agentExists;
    this.describe = options.describe;
    this.store = new SqlRecordStore({
      database: options.database,
      kind: "task",
      schema: TaskSchema,
      logger: this.logger,
      label: "task",
    });
  }

  // A daemon that stopped mid-generation leaves descriptionPending set; nothing will clear it.
  async start(): Promise<void> {
    for (const task of await this.store.list()) {
      if (!task.descriptionPending) continue;
      await this.store.put({ ...task, descriptionPending: false });
    }
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        this.logger.error({ err: error }, "Task listener failed");
      }
    }
  }

  async list(): Promise<Task[]> {
    const tasks = await this.store.list();
    return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(taskId: string): Promise<Task> {
    const task = await this.store.get(taskId);
    if (!task) throw new TaskError("task_not_found", "Task not found");
    return task;
  }

  private async assertLinks(links: readonly TaskLink[]): Promise<void> {
    for (const link of links) {
      const agentId = link.kind === "agent" ? link.agentId : link.parentAgentId;
      if (!(await this.agentExists(agentId))) {
        throw new TaskError("agent_not_found", "Linked chat not found");
      }
    }
  }

  async create(input: TaskCreateOptions): Promise<{ task: Task; created: boolean }> {
    const links = dedupeLinks(input.links ?? []);
    const creator = links.find((link) => link.role === "creator");
    if (creator) {
      const existing = (await this.store.list()).find(
        (task) =>
          task.status !== "done" &&
          titleKey(task.title) === titleKey(input.title) &&
          task.links.some((link) => link.role === "creator" && linkKey(link) === linkKey(creator)),
      );
      if (existing) return { task: existing, created: false };
    }
    await this.assertLinks(links);
    const now = new Date().toISOString();
    const status = input.status ?? "todo";
    const description = input.description ?? "";
    const sourceAgentId = description === "" ? describeSourceAgent(links) : null;
    const task: Task = {
      id: randomUUID(),
      title: input.title,
      description,
      descriptionPending: sourceAgentId !== null,
      status,
      links,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      ...(status === "done" ? { completedAt: now } : {}),
    };
    const saved = await this.store.put(task);
    if (input.labelIds?.length) {
      try {
        await this.labels.setTargetLabels({ kind: "task", taskId: saved.id }, input.labelIds);
      } catch (error) {
        await this.store.delete(saved.id);
        throw error;
      }
    }
    this.changed();
    if (sourceAgentId) void this.generateDescription(saved.id, saved.title, sourceAgentId);
    return { task: saved, created: true };
  }

  // Runs after create returns. A failure leaves the description empty and clears the pending flag.
  private async generateDescription(taskId: string, title: string, agentId: string): Promise<void> {
    let description: string | null = null;
    try {
      description = await this.describe({ title, agentId });
    } catch (error) {
      this.logger.error({ err: error, taskId }, "Task description generation failed");
    }
    const updated = await this.store.update(taskId, (current) => {
      // The user may have typed one while the model ran.
      const keep = current.description !== "" || !description;
      return {
        ...current,
        descriptionPending: false,
        ...(keep ? {} : { description: description ?? "" }),
      };
    });
    if (updated) this.changed();
  }

  async update(taskId: string, patch: TaskUpdateInput): Promise<Task> {
    const now = new Date().toISOString();
    const updated = await this.store.update(taskId, (current) => {
      const status = patch.status ?? current.status;
      const next: Task = {
        ...current,
        title: patch.title ?? current.title,
        description: patch.description ?? current.description,
        status,
        // A hand-written description ends any generation in flight.
        descriptionPending: patch.description === undefined ? current.descriptionPending : false,
        updatedAt: now,
      };
      if (status === "done") {
        next.completedAt = current.status === "done" ? (current.completedAt ?? now) : now;
      } else {
        delete next.completedAt;
      }
      return next;
    });
    if (!updated) throw new TaskError("task_not_found", "Task not found");
    this.changed();
    return updated;
  }

  async delete(taskId: string): Promise<void> {
    this.labels.removeTarget({ kind: "task", taskId });
    await this.store.delete(taskId);
    this.changed();
  }

  async setLink(taskId: string, target: TaskLinkTarget, linked: boolean): Promise<Task> {
    const current = await this.get(taskId);
    const has = current.links.some((link) => linkKey(link) === linkKey(target));
    if (has === linked) return current;
    if (linked) await this.assertLinks([{ ...target, role: "linked" }]);
    const updated = await this.store.update(taskId, (task) => ({
      ...task,
      links: linked
        ? [...task.links, { ...target, role: "linked" as const }]
        : task.links.filter((link) => linkKey(link) !== linkKey(target)),
      updatedAt: new Date().toISOString(),
    }));
    if (!updated) throw new TaskError("task_not_found", "Task not found");
    this.changed();
    return updated;
  }

  // Drops a deleted chat from every task's links, including provider subagents under it.
  async removeAgentLinks(agentId: string): Promise<void> {
    let touched = false;
    for (const task of await this.store.list()) {
      const links = task.links.filter(
        (link) => (link.kind === "agent" ? link.agentId : link.parentAgentId) !== agentId,
      );
      if (links.length === task.links.length) continue;
      await this.store.put({ ...task, links });
      touched = true;
    }
    if (touched) this.changed();
  }

  async import(
    records: readonly TaskImportRecord[],
  ): Promise<{ imported: number; skipped: number }> {
    let imported = 0;
    let skipped = 0;
    for (const record of records) {
      try {
        if (await this.store.get(record.id)) {
          skipped += 1;
          continue;
        }
        const createdAt = record.createdAt ?? new Date().toISOString();
        const links: TaskLink[] =
          record.creatorAgentId && (await this.agentExists(record.creatorAgentId))
            ? [{ kind: "agent", agentId: record.creatorAgentId, role: "creator" }]
            : [];
        const labelIds = [
          ...new Set(
            record.labelNames.map((name) => {
              return this.labels.ensure({ name, color: "violet" }).id;
            }),
          ),
        ];
        const completedAt =
          record.status === "done" ? (record.completedAt ?? createdAt) : undefined;
        await this.store.put({
          id: record.id,
          title: record.title,
          description: record.description,
          descriptionPending: false,
          status: record.status,
          links,
          createdBy: links.length ? "agent" : "user",
          createdAt,
          updatedAt: completedAt ?? createdAt,
          ...(completedAt ? { completedAt } : {}),
        });
        if (labelIds.length) {
          const target: LabelTarget = { kind: "task", taskId: record.id };
          await this.labels.setTargetLabels(target, labelIds);
        }
        imported += 1;
      } catch (error) {
        this.logger.error({ err: error, taskId: record.id }, "Skipping task that failed to import");
        skipped += 1;
      }
    }
    if (imported) this.changed();
    return { imported, skipped };
  }
}

function dedupeLinks(links: readonly TaskLink[]): TaskLink[] {
  const seen = new Map<string, TaskLink>();
  for (const link of links) {
    const existing = seen.get(linkKey(link));
    if (!existing || (link.role === "creator" && existing.role !== "creator")) {
      seen.set(linkKey(link), link);
    }
  }
  return [...seen.values()];
}
