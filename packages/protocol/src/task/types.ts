import { z } from "zod";

export const TASK_TITLE_MAX_LENGTH = 100;
export const TASK_DESCRIPTION_MAX_LENGTH = 2400;

export const TaskStatusSchema = z.enum(["todo", "in_progress", "done"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskCreatedBySchema = z.enum(["user", "agent", "ask-pimi"]);
export type TaskCreatedBy = z.infer<typeof TaskCreatedBySchema>;

export const TaskTitleSchema = z.string().trim().min(1).max(TASK_TITLE_MAX_LENGTH);
export const TaskDescriptionSchema = z.string().max(TASK_DESCRIPTION_MAX_LENGTH);

/**
 * A chat a task points at. `agent` is a chat or a managed subagent; `subagent` is a provider
 * subagent, whose parent chat the UI shows.
 */
export const TaskLinkTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent"), agentId: z.string() }),
  z.object({ kind: z.literal("subagent"), parentAgentId: z.string(), subagentId: z.string() }),
]);
export type TaskLinkTarget = z.infer<typeof TaskLinkTargetSchema>;

// `creator` is the chat the task was made from; every other link is `linked`.
export const TaskLinkRoleSchema = z.enum(["creator", "linked"]);
export type TaskLinkRole = z.infer<typeof TaskLinkRoleSchema>;

export const TaskLinkSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent"), agentId: z.string(), role: TaskLinkRoleSchema }),
  z.object({
    kind: z.literal("subagent"),
    parentAgentId: z.string(),
    subagentId: z.string(),
    role: TaskLinkRoleSchema,
  }),
]);
export type TaskLink = z.infer<typeof TaskLinkSchema>;

/**
 * Labels are not on the record: they live in the label assignment store under the target
 * `{ kind: "task", taskId }` (see `../labels.ts`).
 */
export const TaskSchema = z.object({
  id: z.string(),
  title: TaskTitleSchema,
  description: TaskDescriptionSchema,
  // True while the daemon generates the description; the service pushes `tasks_changed` when it settles.
  descriptionPending: z.boolean(),
  status: TaskStatusSchema,
  links: z.array(TaskLinkSchema),
  createdBy: TaskCreatedBySchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
});
export type Task = z.infer<typeof TaskSchema>;

/**
 * Wire create. The daemon stamps `createdBy: "user"`. A create with an empty description and a
 * `creator` link starts description generation. `labelIds` become assignments on the new task.
 */
export const TaskCreateInputSchema = z.object({
  title: TaskTitleSchema,
  description: TaskDescriptionSchema.optional(),
  status: TaskStatusSchema.optional(),
  labelIds: z.array(z.string()).optional(),
  links: z.array(TaskLinkSchema).optional(),
});
export type TaskCreateInput = z.infer<typeof TaskCreateInputSchema>;

/** Omitted fields stay as they are. Links and labels have their own RPCs. */
export const TaskUpdateInputSchema = z.object({
  title: TaskTitleSchema.optional(),
  description: TaskDescriptionSchema.optional(),
  status: TaskStatusSchema.optional(),
});
export type TaskUpdateInput = z.infer<typeof TaskUpdateInputSchema>;

/**
 * One task read from the old desktop `pimi-tasks.json`, already mapped by the sender
 * (`brief` -> description, five stages -> three statuses, `source.agentId` -> creator link).
 * The daemon skips a record whose `id` already exists and resolves `labelNames` against the
 * catalog case-insensitively, creating a missing name.
 */
export const TaskImportRecordSchema = z.object({
  id: z.string(),
  title: TaskTitleSchema,
  description: TaskDescriptionSchema,
  status: TaskStatusSchema,
  labelNames: z.array(z.string()),
  creatorAgentId: z.string().optional(),
  createdAt: z.string().optional(),
  completedAt: z.string().optional(),
});
export type TaskImportRecord = z.infer<typeof TaskImportRecordSchema>;
