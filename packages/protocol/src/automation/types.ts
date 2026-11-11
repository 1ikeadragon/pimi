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
  z.object({ kind: z.literal("compiled") }),
]);
export type AutomationActor = z.infer<typeof AutomationActorSchema>;

// `compiled`: the owner saved a graph an LLM compiled from prose. Like an agent's automation, it
// waits for the owner's approval.
export const AutomationOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }),
  z.object({ kind: z.literal("agent"), agentId: z.string() }),
  z.object({ kind: z.literal("compiled") }),
]);
export type AutomationOrigin = z.infer<typeof AutomationOriginSchema>;

export const PullRequestEventSchema = z.enum(["opened", "synchronize", "review_requested"]);
export type PullRequestEvent = z.infer<typeof PullRequestEventSchema>;

export const AutomationTriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("schedule"), cadence: CadenceSchema }),
  z.object({ kind: z.literal("manual") }),
  // Polled with the host's `gh` CLI. `repo` is owner/name on github.com.
  z.object({
    kind: z.literal("pull_request"),
    repo: z.string(),
    events: z.array(PullRequestEventSchema),
  }),
]);
export type AutomationTrigger = z.infer<typeof AutomationTriggerSchema>;

// `prompt` may reference `{{steps.<nodeId>.output}}` of an upstream step and `{{trigger.<field>}}`.
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

export const AutomationConditionOperatorSchema = z.enum([
  "contains",
  "not_contains",
  "equals",
  "not_equals",
  "matches",
  "is_empty",
  "not_empty",
]);
export type AutomationConditionOperator = z.infer<typeof AutomationConditionOperatorSchema>;

// Tests `input` (a template, usually `{{steps.<nodeId>.output}}`) and follows the outgoing edges
// whose `branch` matches the result. Text tests ignore case and surrounding whitespace; `matches`
// takes a case-insensitive regular expression.
export const AutomationConditionNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("condition"),
  title: z.string(),
  input: z.string(),
  operator: AutomationConditionOperatorSchema,
  value: z.string(),
});
export type AutomationConditionNode = z.infer<typeof AutomationConditionNodeSchema>;

export const AutomationNodeSchema = z.discriminatedUnion("kind", [
  AutomationAgentNodeSchema,
  AutomationConditionNodeSchema,
]);
export type AutomationNode = z.infer<typeof AutomationNodeSchema>;

export const AutomationEdgeBranchSchema = z.enum(["true", "false"]);
export type AutomationEdgeBranch = z.infer<typeof AutomationEdgeBranchSchema>;

// `branch` is set exactly on edges leaving a condition node.
export const AutomationEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  branch: AutomationEdgeBranchSchema.optional(),
});
export type AutomationEdge = z.infer<typeof AutomationEdgeSchema>;

// A directed acyclic graph of steps. A step runs once every step it depends on has finished;
// steps with nothing between them run at the same time. One agent node is a one-step automation.
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

// The last time the daemon polled a pull-request trigger, and why that poll failed.
export const AutomationTriggerCheckSchema = z.object({
  at: z.string(),
  error: z.string().nullable(),
});
export type AutomationTriggerCheck = z.infer<typeof AutomationTriggerCheckSchema>;

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
  triggerCheck: AutomationTriggerCheckSchema.nullable().optional(),
});
export type Automation = z.infer<typeof AutomationSchema>;

export const AutomationPullRequestEventSchema = z.object({
  kind: z.literal("pull_request"),
  action: PullRequestEventSchema,
  repo: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  author: z.string(),
  headSha: z.string(),
  headRef: z.string(),
  baseRef: z.string(),
});
export type AutomationPullRequestEvent = z.infer<typeof AutomationPullRequestEventSchema>;

export const AutomationRunCauseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("trigger"),
    event: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("schedule"), scheduledFor: z.string() }),
      AutomationPullRequestEventSchema,
    ]),
  }),
  z.object({ kind: z.literal("manual"), actor: AutomationActorSchema }),
  // Re-runs the steps of `runId` that did not succeed, reusing the outputs of those that did.
  z.object({ kind: z.literal("retry"), actor: AutomationActorSchema, runId: z.string() }),
]);
export type AutomationRunCause = z.infer<typeof AutomationRunCauseSchema>;

// `skipped`: a condition sent the run down another branch, or a step it depends on failed.
export const AutomationRunStepStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
]);
export type AutomationRunStepStatus = z.infer<typeof AutomationRunStepStatusSchema>;

export const AutomationRunStepSchema = z.object({
  nodeId: z.string(),
  status: AutomationRunStepStatusSchema,
  agentId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  // True only when the run made a new worktree for this step. Cleanup removes that worktree; a
  // project directory or a worktree the run found is never torn down or removed. Absent counts
  // as false, so cleanup removes nothing it cannot prove the run made.
  createdWorktree: z.boolean().optional(),
  modeId: z.string().nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  output: z.string().nullable(),
  error: z.string().nullable(),
  // Set when a retry copied this step's result from an earlier run instead of running it. That
  // run owns the step's workspace.
  reusedFrom: z.string().optional(),
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

// A description being compiled into a pending automation in the background. A ready draft names
// the automation it became; a failed one keeps the reason so the owner can retry.
export const AutomationDraftStateSchema = z.enum(["drafting", "ready", "failed"]);
export type AutomationDraftState = z.infer<typeof AutomationDraftStateSchema>;

export const AutomationDraftSchema = z.object({
  id: z.string(),
  description: z.string(),
  cwd: z.string(),
  state: AutomationDraftStateSchema,
  error: z.string().nullable(),
  automationId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AutomationDraft = z.infer<typeof AutomationDraftSchema>;
