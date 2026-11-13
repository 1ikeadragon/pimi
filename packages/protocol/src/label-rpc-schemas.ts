import { z } from "zod";
import {
  LabelAssignmentSchema,
  LabelColorSchema,
  LabelSchema,
  LabelTargetSchema,
} from "./labels.js";

// With `subscribe`, the daemon pushes `label.update` messages after the snapshot response.
export const LabelListRequestSchema = z.object({
  type: z.literal("label.list.request"),
  requestId: z.string(),
  subscribe: z.object({}).optional(),
});

export const LabelCreateRequestSchema = z.object({
  type: z.literal("label.create.request"),
  requestId: z.string(),
  name: z.string(),
  color: LabelColorSchema,
});

// A name and a colour are one edit; omitting one leaves it alone.
export const LabelUpdateRequestSchema = z.object({
  type: z.literal("label.update.request"),
  requestId: z.string(),
  labelId: z.string(),
  name: z.string().optional(),
  color: LabelColorSchema.optional(),
});

// Strips the label from every target in one transaction.
export const LabelDeleteRequestSchema = z.object({
  type: z.literal("label.delete.request"),
  requestId: z.string(),
  labelId: z.string(),
});

export const LabelDeleteInspectRequestSchema = z.object({
  type: z.literal("label.delete.inspect.request"),
  requestId: z.string(),
  labelId: z.string(),
});

export const LabelAssignmentSetRequestSchema = z.object({
  type: z.literal("label.assignment.set.request"),
  requestId: z.string(),
  target: LabelTargetSchema,
  labelId: z.string(),
  assigned: z.boolean(),
});

export const LabelListResponseSchema = z.object({
  type: z.literal("label.list.response"),
  payload: z.object({
    requestId: z.string(),
    subscriptionId: z.string().optional(),
    labels: z.array(LabelSchema),
    assignments: z.array(LabelAssignmentSchema),
  }),
});

export const LabelCreateResponseSchema = z.object({
  type: z.literal("label.create.response"),
  payload: z.object({ requestId: z.string(), label: LabelSchema }),
});

export const LabelUpdateResponseSchema = z.object({
  type: z.literal("label.update.response"),
  payload: z.object({ requestId: z.string(), label: LabelSchema }),
});

export const LabelDeleteResponseSchema = z.object({
  type: z.literal("label.delete.response"),
  payload: z.object({
    requestId: z.string(),
    labelId: z.string(),
    affectedCount: z.number().int().nonnegative(),
  }),
});

export const LabelDeleteInspectResponseSchema = z.object({
  type: z.literal("label.delete.inspect.response"),
  payload: z.object({
    requestId: z.string(),
    labelId: z.string(),
    affectedCount: z.number().int().nonnegative(),
  }),
});

export const LabelAssignmentSetResponseSchema = z.object({
  type: z.literal("label.assignment.set.response"),
  payload: z.object({
    requestId: z.string(),
    target: LabelTargetSchema,
    labelIds: z.array(z.string()),
  }),
});

// Push for `label.list.request` subscribers. `assignment_set` carries the target's full label
// set; an empty set removes the assignment (also pushed when a task or agent is deleted).
export const LabelUpdateSchema = z.object({
  type: z.literal("label.update"),
  payload: z.discriminatedUnion("kind", [
    z.object({
      subscriptionId: z.string().optional(),
      kind: z.literal("label_upsert"),
      label: LabelSchema,
    }),
    z.object({
      subscriptionId: z.string().optional(),
      kind: z.literal("label_remove"),
      labelId: z.string(),
    }),
    z.object({
      subscriptionId: z.string().optional(),
      kind: z.literal("assignment_set"),
      target: LabelTargetSchema,
      labelIds: z.array(z.string()),
    }),
  ]),
});
