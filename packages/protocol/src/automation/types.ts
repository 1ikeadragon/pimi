import { z } from "zod";
import { AgentProviderSchema } from "../provider-manifest.js";
import { CadenceSchema } from "../schedule/cadence.js";

export const AutomationStatusSchema = z.enum(["pending", "active", "paused", "ended"]);
export type AutomationStatus = z.infer<typeof AutomationStatusSchema>;

export const AutomationPausedReasonSchema = z.enum(["user", "failures"]);
export type AutomationPausedReason = z.infer<typeof AutomationPausedReasonSchema>;

export const AutomationActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }),
  z.object({ kind: z.literal("daemon") }),
  z.object({ kind: z.literal("agent"), agentId: z.string() }),
]);
export type AutomationActor = z.infer<typeof AutomationActorSchema>;

export const AutomationOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }),
  z.object({ kind: z.literal("agent"), agentId: z.string() }),
]);
export type AutomationOrigin = z.infer<typeof AutomationOriginSchema>;

export const AutomationTriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("schedule"), cadence: CadenceSchema }),
  z.object({ kind: z.literal("manual") }),
]);
export type AutomationTrigger = z.infer<typeof AutomationTriggerSchema>;

export const AutomationAgentNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("agent"),
  title: z.string(),
  // An agent profile: its instructions become the agent's system prompt when the step starts,
  // and its model, mode and thinking apply where the step sets none.
  profileId: z.string().min(1).optional(),
  provider: AgentProviderSchema,
  model: z.string().min(1).optional(),
  thinkingOptionId: z.string().min(1).optional(),
  modeId: z.string().min(1).optional(),
  featureValues: z.record(z.string(), z.unknown()).optional(),
  workspace: z.enum(["project", "worktree"]),
  prompt: z.string(),
});
export type AutomationAgentNode = z.infer<typeof AutomationAgentNodeSchema>;

export const AutomationOutputNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("output"),
  output: z.object({ type: z.literal("chat") }),
});
export type AutomationOutputNode = z.infer<typeof AutomationOutputNodeSchema>;

export const AutomationNodeSchema = z.discriminatedUnion("kind", [
  AutomationAgentNodeSchema,
  AutomationOutputNodeSchema,
]);
export type AutomationNode = z.infer<typeof AutomationNodeSchema>;

export const AutomationEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
});
export type AutomationEdge = z.infer<typeof AutomationEdgeSchema>;

export const AutomationFlowSchema = z.object({
  nodes: z.array(AutomationNodeSchema),
  edges: z.array(AutomationEdgeSchema),
});
export type AutomationFlow = z.infer<typeof AutomationFlowSchema>;

export const AutomationLimitsSchema = z.object({
  maxRuntimeMs: z.number().int().positive(),
  maxRunsPerHour: z.number().int().positive(),
  maxConcurrentRuns: z.number().int().positive(),
  maxRuns: z.number().int().positive().nullable(),
  expiresAt: z.string().nullable(),
});
export type AutomationLimits = z.infer<typeof AutomationLimitsSchema>;

export const DEFAULT_AUTOMATION_LIMITS: AutomationLimits = {
  maxRuntimeMs: 60 * 60_000,
  maxRunsPerHour: 6,
  maxConcurrentRuns: 2,
  maxRuns: null,
  expiresAt: null,
};

// What a client or agent sends to create or replace an automation. Limits left out take
// the defaults above.
export const AutomationDefinitionSchema = z.object({
  name: z.string(),
  description: z.string().nullable().optional(),
  project: z.object({ cwd: z.string() }),
  trigger: AutomationTriggerSchema,
  flow: AutomationFlowSchema,
  limits: AutomationLimitsSchema.partial().optional(),
});
export type AutomationDefinition = z.infer<typeof AutomationDefinitionSchema>;

export const AutomationRunStatusSchema = z.enum(["running", "succeeded", "failed", "cancelled"]);
export type AutomationRunStatus = z.infer<typeof AutomationRunStatusSchema>;

export const AutomationLastRunSchema = z.object({
  id: z.string(),
  status: AutomationRunStatusSchema,
  startedAt: z.string(),
  endedAt: z.string().nullable(),
});
export type AutomationLastRun = z.infer<typeof AutomationLastRunSchema>;

export const AutomationSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: AutomationStatusSchema,
  pausedReason: AutomationPausedReasonSchema.nullable(),
  origin: AutomationOriginSchema,
  project: z.object({ cwd: z.string() }),
  trigger: AutomationTriggerSchema,
  flow: AutomationFlowSchema,
  limits: AutomationLimitsSchema,
  revision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
  nextRunAt: z.string().nullable(),
  lastRun: AutomationLastRunSchema.nullable(),
  runCount: z.number().int().nonnegative(),
  consecutiveFailures: z.number().int().nonnegative(),
});
export type Automation = z.infer<typeof AutomationSchema>;

export const AutomationRunCauseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("trigger"),
    event: z.object({ kind: z.literal("schedule"), scheduledFor: z.string() }),
  }),
  z.object({ kind: z.literal("manual"), actor: AutomationActorSchema }),
]);
export type AutomationRunCause = z.infer<typeof AutomationRunCauseSchema>;

export const AutomationRunStepSchema = z.object({
  nodeId: z.string(),
  status: AutomationRunStatusSchema,
  agentId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  // True only when the run made a new worktree for this step. Cleanup removes that worktree; a
  // project directory or a worktree the run found is never torn down or removed. Absent counts
  // as false, so cleanup removes nothing it cannot prove the run made.
  createdWorktree: z.boolean().optional(),
  modeId: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  output: z.string().nullable(),
  error: z.string().nullable(),
});
export type AutomationRunStep = z.infer<typeof AutomationRunStepSchema>;

export const AutomationRunSchema = z.object({
  id: z.string(),
  automationId: z.string(),
  revision: z.number().int().positive(),
  cause: AutomationRunCauseSchema,
  dedupeKey: z.string(),
  status: AutomationRunStatusSchema,
  unread: z.boolean(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  reportAgentId: z.string().nullable(),
  reportWorkspaceId: z.string().nullable(),
  steps: z.array(AutomationRunStepSchema),
  error: z.string().nullable(),
});
export type AutomationRun = z.infer<typeof AutomationRunSchema>;

export const AutomationAuditActionSchema = z.enum([
  "created",
  "updated",
  "approved",
  "enabled",
  "paused",
  "auto_paused",
  "ended",
  "deleted",
  "run_started",
  "run_finished",
  "run_skipped",
]);
export type AutomationAuditAction = z.infer<typeof AutomationAuditActionSchema>;

export const AutomationAuditEntrySchema = z.object({
  at: z.string(),
  automationId: z.string(),
  action: AutomationAuditActionSchema,
  actor: AutomationActorSchema,
  runId: z.string().nullable(),
  detail: z.string().nullable(),
});
export type AutomationAuditEntry = z.infer<typeof AutomationAuditEntrySchema>;
