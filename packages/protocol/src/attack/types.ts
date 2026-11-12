import { z } from "zod";

export const ATTACK_ROLE_IDS = ["ui-qa", "secrets-audit"] as const;
export const AttackRoleIdSchema = z.enum(ATTACK_ROLE_IDS);
export type AttackRoleId = z.infer<typeof AttackRoleIdSchema>;

export const AttackRunStatusSchema = z.enum(["running", "paused", "stopped", "completed"]);
export type AttackRunStatus = z.infer<typeof AttackRunStatusSchema>;

// Why a run is paused: the owner pressed Pause, a budget ran out, or no agent was working and the
// lead did not answer a nudge to finish.
export const AttackPauseReasonSchema = z.enum(["user", "time_budget", "token_budget", "stalled"]);
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

// An element the owner marked in the live target before the run, with their note. `label` is "A1",
// "A2", ... in the order they were added.
export const AttackAnnotationSchema = z.object({
  label: z.string().min(1).max(16),
  url: z.string().max(2000),
  selector: z.string().max(1000),
  tag: z.string().max(100),
  text: z.string().max(400),
  html: z.string().max(800),
  note: z.string().max(2000),
});
export type AttackAnnotation = z.infer<typeof AttackAnnotationSchema>;
export const MAX_ATTACK_ANNOTATIONS = 40;

// The app window a run drives instead of (or beside) a URL. Resolved by bundle id at every action.
export const AttackDesktopTargetSchema = z.object({
  bundleId: z.string().min(1).max(200),
  appName: z.string().min(1).max(200),
  windowTitle: z.string().max(400),
});
export type AttackDesktopTarget = z.infer<typeof AttackDesktopTargetSchema>;

// Why an annotation has no finding: the agent tested it and it held, or it could not be tested.
export const AttackAnnotationResultSchema = z.object({
  result: z.enum(["clean", "not_testable"]),
  note: z.string().max(1000),
});
export type AttackAnnotationResult = z.infer<typeof AttackAnnotationResultSchema>;

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
  // Pre-flight notes: they join the general pass, or replace it when `onlyAnnotated` is set.
  annotations: z.array(AttackAnnotationSchema).max(MAX_ATTACK_ANNOTATIONS).default([]),
  onlyAnnotated: z.boolean().default(false),
  // A run needs a URL target or a desktop target. Desktop clicks and typing need `allowDesktopInput`
  // (the owner's per-run consent) or `disposableTarget`.
  desktopTarget: AttackDesktopTargetSchema.nullable().default(null),
  allowDesktopInput: z.boolean().default(false),
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
  annotations: z.array(AttackAnnotationSchema).default([]),
  onlyAnnotated: z.boolean().default(false),
  desktopTarget: AttackDesktopTargetSchema.nullable().default(null),
  allowDesktopInput: z.boolean().default(false),
  // Per annotation label, what the agents concluded when no finding covers it.
  annotationResults: z.record(z.string(), AttackAnnotationResultSchema).default({}),
  // Tokens by agent id, at most 16 agents.
  spentByAgent: z.record(z.string(), z.number().int().nonnegative()).default({}),
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
  // Pre-flight annotation labels ("A1") this finding is about.
  annotationLabels: z.array(z.string()).default([]),
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
  "budget_extended",
  "run_stopped",
  "run_completed",
  "budget_reached",
  "agent_started",
  "finding_submitted",
  "finding_deduped",
  "finding_updated",
  "navigation_refused",
  "desktop_action",
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

// Routes the run's agents visited in a browser, from the app's browser store. Path only, no query.
export const AttackCoverageRouteSchema = z.object({
  agentIds: z.array(z.string()),
  visits: z.number().int().positive(),
  firstAt: z.string(),
});
export type AttackCoverageRoute = z.infer<typeof AttackCoverageRouteSchema>;
// At most 500 routes.
export const AttackCoverageSchema = z.record(z.string(), AttackCoverageRouteSchema);
export type AttackCoverage = z.infer<typeof AttackCoverageSchema>;

// One desktop-target action an agent took, for the Desktop subview's log. Never typed text.
export const AttackDesktopActionSchema = z.object({
  runId: z.string(),
  agentId: z.string(),
  verb: z.enum(["snapshot", "click", "type", "key", "screenshot"]),
  role: z.string().nullable(),
  label: z.string().nullable(),
  point: z.object({ x: z.number(), y: z.number() }).nullable(),
  at: z.string(),
});
export type AttackDesktopAction = z.infer<typeof AttackDesktopActionSchema>;
