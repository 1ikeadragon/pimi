import { z } from "zod";
import { AutomationFlowSchema, AutomationRunStepSchema } from "../automation/types.js";

// A flow is invoked as `/name`, so the name is a slug that is safe in a slash command.
export const FLOW_NAME_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
export const MAX_FLOW_NAME_LENGTH = 48;

export const FlowOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }),
  z.object({ kind: z.literal("agent"), agentId: z.string() }),
]);
export type FlowOrigin = z.infer<typeof FlowOriginSchema>;

// What a client or agent sends to create or replace a flow. Step prompts may use `{{input}}`,
// the text the chat passed when it ran the flow.
export const FlowDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  argumentHint: z.string().optional(),
  flow: AutomationFlowSchema,
});
export type FlowDefinition = z.infer<typeof FlowDefinitionSchema>;

// A saved, host-wide graph of agent steps and judge gates, run only from a chat. A flow an agent
// saved is not approved and does not run until the owner approves it.
export const FlowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  argumentHint: z.string().optional(),
  flow: AutomationFlowSchema,
  origin: FlowOriginSchema,
  approved: z.boolean(),
  revision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Flow = z.infer<typeof FlowSchema>;

// `awaiting_approval`: an agent asked to run a flow the owner has not approved yet.
// `not_met`: a gate ran out of attempts, so the outcome never ran.
export const FlowRunStatusSchema = z.enum([
  "awaiting_approval",
  "running",
  "succeeded",
  "not_met",
  "failed",
  "cancelled",
]);
export type FlowRunStatus = z.infer<typeof FlowRunStatusSchema>;

export const FlowRunSchema = z.object({
  id: z.string(),
  flowId: z.string(),
  flowName: z.string(),
  revision: z.number().int().positive(),
  // The chat that invoked the run; it receives the result.
  agentId: z.string(),
  workspaceId: z.string(),
  cwd: z.string(),
  input: z.string(),
  status: FlowRunStatusSchema,
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  steps: z.array(AutomationRunStepSchema),
  // The final step's output when the run succeeded, the last failing feedback when not met, the
  // failure otherwise.
  output: z.string().nullable(),
  error: z.string().nullable(),
});
export type FlowRun = z.infer<typeof FlowRunSchema>;
