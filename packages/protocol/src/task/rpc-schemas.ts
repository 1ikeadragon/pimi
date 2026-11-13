import { z } from "zod";
import {
  TaskCreateInputSchema,
  TaskImportRecordSchema,
  TaskLinkTargetSchema,
  TaskSchema,
  TaskUpdateInputSchema,
} from "./types.js";

export const TaskListRequestSchema = z.object({
  type: z.literal("task.list.request"),
  requestId: z.string(),
});

export const TaskGetRequestSchema = z.object({
  type: z.literal("task.get.request"),
  requestId: z.string(),
  taskId: z.string(),
});

export const TaskCreateRequestSchema = z.object({
  type: z.literal("task.create.request"),
  requestId: z.string(),
  task: TaskCreateInputSchema,
});

export const TaskUpdateRequestSchema = z.object({
  type: z.literal("task.update.request"),
  requestId: z.string(),
  taskId: z.string(),
  update: TaskUpdateInputSchema,
});

// Also strips the task's label assignments.
export const TaskDeleteRequestSchema = z.object({
  type: z.literal("task.delete.request"),
  requestId: z.string(),
  taskId: z.string(),
});

// Linking an already linked target, or unlinking an unlinked one, changes nothing.
export const TaskLinkSetRequestSchema = z.object({
  type: z.literal("task.link.set.request"),
  requestId: z.string(),
  taskId: z.string(),
  target: TaskLinkTargetSchema,
  linked: z.boolean(),
});

// One-shot import of the old desktop task file. Idempotent per record id.
export const TaskImportRequestSchema = z.object({
  type: z.literal("task.import.request"),
  requestId: z.string(),
  tasks: z.array(TaskImportRecordSchema),
});

const TaskPayloadSchema = z.object({ requestId: z.string(), task: TaskSchema });

export const TaskListResponseSchema = z.object({
  type: z.literal("task.list.response"),
  payload: z.object({ requestId: z.string(), tasks: z.array(TaskSchema) }),
});

export const TaskGetResponseSchema = z.object({
  type: z.literal("task.get.response"),
  payload: TaskPayloadSchema,
});

// `created: false` when the daemon returned an existing task instead (same creator, same title, not done).
export const TaskCreateResponseSchema = z.object({
  type: z.literal("task.create.response"),
  payload: z.object({ requestId: z.string(), task: TaskSchema, created: z.boolean() }),
});

export const TaskUpdateResponseSchema = z.object({
  type: z.literal("task.update.response"),
  payload: TaskPayloadSchema,
});

export const TaskDeleteResponseSchema = z.object({
  type: z.literal("task.delete.response"),
  payload: z.object({ requestId: z.string(), taskId: z.string() }),
});

export const TaskLinkSetResponseSchema = z.object({
  type: z.literal("task.link.set.response"),
  payload: TaskPayloadSchema,
});

export const TaskImportResponseSchema = z.object({
  type: z.literal("task.import.response"),
  payload: z.object({
    requestId: z.string(),
    imported: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }),
});
