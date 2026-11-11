import { z } from "zod";
import {
  AutomationAuditEntrySchema,
  AutomationDefinitionSchema,
  AutomationOriginSchema,
  AutomationRunSchema,
  AutomationSchema,
} from "./types.js";

const AutomationIdRequestShape = {
  requestId: z.string(),
  automationId: z.string(),
};

const AutomationRunIdRequestShape = {
  requestId: z.string(),
  automationId: z.string(),
  runId: z.string(),
};

export const AutomationCreateRequestSchema = z.object({
  type: z.literal("automation.create.request"),
  requestId: z.string(),
  definition: AutomationDefinitionSchema,
  // An agent creating an automation through a client (the CLI inside an agent) says so;
  // such automations wait for the owner's approval.
  origin: AutomationOriginSchema.optional(),
});

export const AutomationGetRequestSchema = z.object({
  type: z.literal("automation.get.request"),
  ...AutomationIdRequestShape,
});

export const AutomationListRequestSchema = z.object({
  type: z.literal("automation.list.request"),
  requestId: z.string(),
});

export const AutomationUpdateRequestSchema = z.object({
  type: z.literal("automation.update.request"),
  ...AutomationIdRequestShape,
  definition: AutomationDefinitionSchema,
  // An agent editing through a client (the CLI inside an agent) says so; the automation then
  // goes back to waiting for the owner's approval.
  origin: AutomationOriginSchema.optional(),
});

export const AutomationDeleteRequestSchema = z.object({
  type: z.literal("automation.delete.request"),
  ...AutomationIdRequestShape,
});

export const AutomationEnableRequestSchema = z.object({
  type: z.literal("automation.enable.request"),
  ...AutomationIdRequestShape,
});

export const AutomationPauseRequestSchema = z.object({
  type: z.literal("automation.pause.request"),
  ...AutomationIdRequestShape,
});

export const AutomationApproveRequestSchema = z.object({
  type: z.literal("automation.approve.request"),
  ...AutomationIdRequestShape,
});

export const AutomationRunStartRequestSchema = z.object({
  type: z.literal("automation.run.start.request"),
  ...AutomationIdRequestShape,
});

export const AutomationRunCancelRequestSchema = z.object({
  type: z.literal("automation.run.cancel.request"),
  ...AutomationRunIdRequestShape,
});

export const AutomationRunListRequestSchema = z.object({
  type: z.literal("automation.run.list.request"),
  requestId: z.string(),
  automationId: z.string().optional(),
  limit: z.number().int().positive().optional(),
});

export const AutomationRunGetRequestSchema = z.object({
  type: z.literal("automation.run.get.request"),
  ...AutomationRunIdRequestShape,
});

export const AutomationRunMarkReadRequestSchema = z.object({
  type: z.literal("automation.run.mark_read.request"),
  ...AutomationRunIdRequestShape,
});

const AutomationPayloadSchema = z.object({
  requestId: z.string(),
  automation: AutomationSchema,
});

const AutomationRunPayloadSchema = z.object({
  requestId: z.string(),
  run: AutomationRunSchema,
});

export const AutomationCreateResponseSchema = z.object({
  type: z.literal("automation.create.response"),
  payload: AutomationPayloadSchema,
});

export const AutomationGetResponseSchema = z.object({
  type: z.literal("automation.get.response"),
  payload: z.object({
    requestId: z.string(),
    automation: AutomationSchema,
    audit: z.array(AutomationAuditEntrySchema),
  }),
});

export const AutomationListResponseSchema = z.object({
  type: z.literal("automation.list.response"),
  payload: z.object({
    requestId: z.string(),
    automations: z.array(AutomationSchema),
  }),
});

export const AutomationUpdateResponseSchema = z.object({
  type: z.literal("automation.update.response"),
  payload: AutomationPayloadSchema,
});

export const AutomationDeleteResponseSchema = z.object({
  type: z.literal("automation.delete.response"),
  payload: z.object({ requestId: z.string(), automationId: z.string() }),
});

export const AutomationEnableResponseSchema = z.object({
  type: z.literal("automation.enable.response"),
  payload: AutomationPayloadSchema,
});

export const AutomationPauseResponseSchema = z.object({
  type: z.literal("automation.pause.response"),
  payload: AutomationPayloadSchema,
});

export const AutomationApproveResponseSchema = z.object({
  type: z.literal("automation.approve.response"),
  payload: AutomationPayloadSchema,
});

export const AutomationRunStartResponseSchema = z.object({
  type: z.literal("automation.run.start.response"),
  payload: AutomationRunPayloadSchema,
});

export const AutomationRunCancelResponseSchema = z.object({
  type: z.literal("automation.run.cancel.response"),
  payload: AutomationRunPayloadSchema,
});

export const AutomationRunListResponseSchema = z.object({
  type: z.literal("automation.run.list.response"),
  payload: z.object({ requestId: z.string(), runs: z.array(AutomationRunSchema) }),
});

export const AutomationRunGetResponseSchema = z.object({
  type: z.literal("automation.run.get.response"),
  payload: AutomationRunPayloadSchema,
});

export const AutomationRunMarkReadResponseSchema = z.object({
  type: z.literal("automation.run.mark_read.response"),
  payload: AutomationRunPayloadSchema,
});

export const AutomationRunRetryRequestSchema = z.object({
  type: z.literal("automation.run.retry.request"),
  ...AutomationRunIdRequestShape,
});

export const AutomationRunRetryResponseSchema = z.object({
  type: z.literal("automation.run.retry.response"),
  payload: AutomationRunPayloadSchema,
});

// An LLM turns a prose description into a draft definition. Nothing is saved.
export const AutomationCompileRequestSchema = z.object({
  type: z.literal("automation.compile.request"),
  requestId: z.string(),
  description: z.string(),
  cwd: z.string(),
});

export const AutomationCompileResponseSchema = z.object({
  type: z.literal("automation.compile.response"),
  payload: z.object({ requestId: z.string(), definition: AutomationDefinitionSchema }),
});

// Polls a pull-request trigger now instead of waiting for its next poll.
export const AutomationTriggerCheckRequestSchema = z.object({
  type: z.literal("automation.trigger.check.request"),
  ...AutomationIdRequestShape,
});

export const AutomationTriggerCheckResponseSchema = z.object({
  type: z.literal("automation.trigger.check.response"),
  payload: z.object({
    requestId: z.string(),
    automation: AutomationSchema,
    started: z.array(AutomationRunSchema),
  }),
});
