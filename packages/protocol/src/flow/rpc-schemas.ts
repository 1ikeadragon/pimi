import { z } from "zod";
import { FlowDefinitionSchema, FlowOriginSchema, FlowRunSchema, FlowSchema } from "./types.js";

const FlowIdRequestShape = { requestId: z.string(), flowId: z.string() };
const FlowRunIdRequestShape = { requestId: z.string(), runId: z.string() };
const FlowPayloadSchema = z.object({ requestId: z.string(), flow: FlowSchema });
const FlowRunPayloadSchema = z.object({ requestId: z.string(), run: FlowRunSchema });

export const FlowListRequestSchema = z.object({
  type: z.literal("flow.list.request"),
  requestId: z.string(),
});
export const FlowListResponseSchema = z.object({
  type: z.literal("flow.list.response"),
  payload: z.object({ requestId: z.string(), flows: z.array(FlowSchema) }),
});

export const FlowGetRequestSchema = z.object({
  type: z.literal("flow.get.request"),
  ...FlowIdRequestShape,
});
export const FlowGetResponseSchema = z.object({
  type: z.literal("flow.get.response"),
  payload: FlowPayloadSchema,
});

export const FlowCreateRequestSchema = z.object({
  type: z.literal("flow.create.request"),
  requestId: z.string(),
  definition: FlowDefinitionSchema,
  // An agent saving through a client says so; its flow waits for the owner's approval.
  origin: FlowOriginSchema.optional(),
});
export const FlowCreateResponseSchema = z.object({
  type: z.literal("flow.create.response"),
  payload: FlowPayloadSchema,
});

export const FlowUpdateRequestSchema = z.object({
  type: z.literal("flow.update.request"),
  ...FlowIdRequestShape,
  definition: FlowDefinitionSchema,
});
export const FlowUpdateResponseSchema = z.object({
  type: z.literal("flow.update.response"),
  payload: FlowPayloadSchema,
});

export const FlowDeleteRequestSchema = z.object({
  type: z.literal("flow.delete.request"),
  ...FlowIdRequestShape,
});
export const FlowDeleteResponseSchema = z.object({
  type: z.literal("flow.delete.response"),
  payload: z.object({ requestId: z.string(), flowId: z.string() }),
});

export const FlowApproveRequestSchema = z.object({
  type: z.literal("flow.approve.request"),
  ...FlowIdRequestShape,
});
export const FlowApproveResponseSchema = z.object({
  type: z.literal("flow.approve.response"),
  payload: FlowPayloadSchema,
});

export const FlowRunGetRequestSchema = z.object({
  type: z.literal("flow.run.get.request"),
  ...FlowRunIdRequestShape,
});
export const FlowRunGetResponseSchema = z.object({
  type: z.literal("flow.run.get.response"),
  payload: FlowRunPayloadSchema,
});

export const FlowRunCancelRequestSchema = z.object({
  type: z.literal("flow.run.cancel.request"),
  ...FlowRunIdRequestShape,
});
export const FlowRunCancelResponseSchema = z.object({
  type: z.literal("flow.run.cancel.response"),
  payload: FlowRunPayloadSchema,
});

// Starts a run again from its first step on the flow as it is now, in the same run record so a
// card showing the run follows it. Works for a run awaiting approval (once the flow is approved),
// not met, failed or cancelled.
export const FlowRunRetryRequestSchema = z.object({
  type: z.literal("flow.run.retry.request"),
  ...FlowRunIdRequestShape,
  // Replaces the run's input, for a card whose person edited it before pressing Start.
  input: z.string().optional(),
});
export const FlowRunRetryResponseSchema = z.object({
  type: z.literal("flow.run.retry.response"),
  payload: FlowRunPayloadSchema,
});

// A `/name input` typed in a chat: makes a run that waits for the card's Start button and puts the
// card in the chat's timeline. No agent turn happens.
export const FlowRunPrepareRequestSchema = z.object({
  type: z.literal("flow.run.prepare.request"),
  requestId: z.string(),
  name: z.string(),
  input: z.string(),
  agentId: z.string(),
});
export const FlowRunPrepareResponseSchema = z.object({
  type: z.literal("flow.run.prepare.response"),
  payload: FlowRunPayloadSchema,
});
