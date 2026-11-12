import { z } from "zod";

export const ATTACK_ROLE_IDS = ["ui-qa", "secrets-audit"] as const;
export const AttackRoleIdSchema = z.enum(ATTACK_ROLE_IDS);
export type AttackRoleId = z.infer<typeof AttackRoleIdSchema>;

export const AttackRunStatusSchema = z.enum(["running", "paused", "stopped", "completed"]);
export type AttackRunStatus = z.infer<typeof AttackRunStatusSchema>;

// Why a run is paused: the owner pressed Pause, or a budget ran out.
export const AttackPauseReasonSchema = z.enum(["user", "time_budget", "token_budget"]);
export type AttackPauseReason = z.infer<typeof AttackPauseReasonSchema>;

export const AttackLimitsSchema = z.object({
  maxRuntimeMs: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
});
export type AttackLimits = z.infer<typeof AttackLimitsSchema>;

export const DEFAULT_ATTACK_LIMITS: AttackLimits = {
  maxRuntimeMs: 30 * 60_000,
  maxTokens: 2_000_000,
};

export const AttackSpentSchema = z.object({
  runtimeMs: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
});
export type AttackSpent = z.infer<typeof AttackSpentSchema>;

// What the owner fills in. `remoteHost` is derived from the target when the target is not local.
export const AttackRunDefinitionSchema = z.object({
  workspaceId: z.string().min(1),
  cwd: z.string().min(1),
  target: z.string().min(1),
  // False keeps the agents out of the repository: no repo scan, no reading its source.
  repoScope: z.boolean(),
  scopeNotes: z.string().max(4000),
  // The lead agent's "provider/model"; its subagents inherit it.
  provider: z.string().min(1),
  roster: z.array(AttackRoleIdSchema).min(1),
  // Writes, deletes and load bursts need this. The MVP roster only reads, so nothing consults it yet.
  disposableTarget: z.boolean(),
  limits: AttackLimitsSchema,
});
export type AttackRunDefinition = z.infer<typeof AttackRunDefinitionSchema>;

export const AttackRunSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  cwd: z.string(),
  target: z.string(),
  // The one non-local host the run may visit, or null when the target is local.
  remoteHost: z.string().nullable(),
  repoScope: z.boolean(),
  scopeNotes: z.string(),
  // The lead's "provider/model"; "Fix it" starts its agent on the same one.
  provider: z.string(),
  roster: z.array(AttackRoleIdSchema),
  disposableTarget: z.boolean(),
  limits: AttackLimitsSchema,
  status: AttackRunStatusSchema,
  pausedReason: AttackPauseReasonSchema.nullable(),
  leadAgentId: z.string().nullable(),
  // Runtime already spent in earlier stretches; the current stretch started at `resumedAt`.
  spent: AttackSpentSchema,
  resumedAt: z.string().nullable(),
  startedAt: z.string(),
  updatedAt: z.string(),
  endedAt: z.string().nullable(),
});
export type AttackRun = z.infer<typeof AttackRunSchema>;

export const FindingSeveritySchema = z.enum(["blocker", "major", "minor"]);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

export const FindingStatusSchema = z.enum(["new", "triaged", "dismissed", "fixed"]);
export type FindingStatus = z.infer<typeof FindingStatusSchema>;

export const FindingCategorySchema = z.enum([
  "functional",
  "ui",
  "input-handling",
  "error-handling",
  "secret-exposure",
  "config",
  "other",
]);
export type FindingCategory = z.infer<typeof FindingCategorySchema>;

// A screenshot keeps its image bytes out of list responses; `finding.get` carries them.
export const FindingEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("screenshot"),
    caption: z.string(),
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative(),
    dataBase64: z.string().nullable(),
  }),
  z.object({ kind: z.literal("terminal"), caption: z.string(), excerpt: z.string() }),
  z.object({ kind: z.literal("note"), caption: z.string(), excerpt: z.string() }),
]);
export type FindingEvidence = z.infer<typeof FindingEvidenceSchema>;

export const FindingSchema = z.object({
  id: z.string(),
  runId: z.string(),
  agentId: z.string().nullable(),
  severity: FindingSeveritySchema,
  category: FindingCategorySchema,
  title: z.string(),
  // The route or file the problem is on.
  route: z.string(),
  description: z.string(),
  repro: z.string(),
  evidence: z.array(FindingEvidenceSchema),
  signature: z.string(),
  status: FindingStatusSchema,
  // How many reports this finding stands for: its own plus every duplicate merged into it.
  reportCount: z.number().int().positive(),
  // Set when the lead merged this finding into another one; clients hide it.
  duplicateOf: z.string().nullable().default(null),
  fixAgentId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const AttackAuditActionSchema = z.enum([
  "run_started",
  "run_paused",
  "run_resumed",
  "run_stopped",
  "run_completed",
  "budget_reached",
  "agent_started",
  "finding_submitted",
  "finding_deduped",
  "finding_updated",
  "navigation_refused",
]);
export type AttackAuditAction = z.infer<typeof AttackAuditActionSchema>;

// Ids and actions only: never URLs with paths or queries, prompts, evidence or agent output.
export const AttackAuditEntrySchema = z.object({
  at: z.string(),
  runId: z.string(),
  action: AttackAuditActionSchema,
  agentId: z.string().nullable(),
  detail: z.string().nullable(),
});
export type AttackAuditEntry = z.infer<typeof AttackAuditEntrySchema>;
