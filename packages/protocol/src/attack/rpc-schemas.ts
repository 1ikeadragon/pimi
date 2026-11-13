import { z } from "zod";
import {
  AttackAuditEntrySchema,
  AttackCoverageRouteSchema,
  AttackCoverageSchema,
  AttackDesktopActionSchema,
  AttackLimitsSchema,
  AttackRunDefinitionSchema,
  AttackRunSchema,
  AttackScheduleAuditEntrySchema,
  AttackScheduleInputSchema,
  AttackScheduleSchema,
  FindingSchema,
  FindingStatusSchema,
} from "./types.js";

const RunIdRequestShape = {
  requestId: z.string(),
  runId: z.string(),
};

export const AttackRunStartRequestSchema = z.object({
  type: z.literal("attack.run.start.request"),
  requestId: z.string(),
  definition: AttackRunDefinitionSchema,
});

export const AttackRunPauseRequestSchema = z.object({
  type: z.literal("attack.run.pause.request"),
  ...RunIdRequestShape,
});

export const AttackRunResumeRequestSchema = z.object({
  type: z.literal("attack.run.resume.request"),
  ...RunIdRequestShape,
  // New limits for a run whose budget is spent; both must exceed what the run has spent.
  limits: AttackLimitsSchema.optional(),
});

export const AttackRunCancelRequestSchema = z.object({
  type: z.literal("attack.run.cancel.request"),
  ...RunIdRequestShape,
});

// The owner's "Stop input": the daemon refuses desktop input verbs for the run, including when
// `disposableTarget` would otherwise allow them. `allow: true` lifts the stop again.
export const AttackRunDesktopInputSetRequestSchema = z.object({
  type: z.literal("attack.run.desktop_input.set.request"),
  ...RunIdRequestShape,
  allow: z.boolean(),
});

export const AttackRunGetRequestSchema = z.object({
  type: z.literal("attack.run.get.request"),
  ...RunIdRequestShape,
});

export const AttackRunListRequestSchema = z.object({
  type: z.literal("attack.run.list.request"),
  requestId: z.string(),
  workspaceId: z.string().optional(),
});

export const AttackFindingListRequestSchema = z.object({
  type: z.literal("attack.finding.list.request"),
  ...RunIdRequestShape,
});

// The one place a finding's screenshot bytes travel.
export const AttackFindingGetRequestSchema = z.object({
  type: z.literal("attack.finding.get.request"),
  ...RunIdRequestShape,
  findingId: z.string(),
});

export const AttackFindingUpdateRequestSchema = z.object({
  type: z.literal("attack.finding.update.request"),
  ...RunIdRequestShape,
  findingId: z.string(),
  status: FindingStatusSchema.optional(),
  // The Agent-mode agent "Fix it" opened for this finding.
  fixAgentId: z.string().optional(),
});

// The desktop app reports a navigation its webview guard refused; the daemon writes the audit line.
export const AttackAuditRecordRequestSchema = z.object({
  type: z.literal("attack.audit.record.request"),
  ...RunIdRequestShape,
  action: z.enum(["navigation_refused"]),
  agentId: z.string().optional(),
  // The refused host only, never the path or query.
  detail: z.string().max(253),
});

// The app reports a route an agent's browser tab reached.
export const AttackCoverageRecordRequestSchema = z.object({
  type: z.literal("attack.coverage.record.request"),
  ...RunIdRequestShape,
  agentId: z.string(),
  route: z.string().min(1).max(500),
});

export const AttackCoverageGetRequestSchema = z.object({
  type: z.literal("attack.coverage.get.request"),
  ...RunIdRequestShape,
});

// The owner folds a finding into another one; the merged finding is hidden.
export const AttackFindingMergeRequestSchema = z.object({
  type: z.literal("attack.finding.merge.request"),
  ...RunIdRequestShape,
  duplicateId: z.string(),
  intoId: z.string(),
});

const RunPayloadSchema = z.object({ requestId: z.string(), run: AttackRunSchema });

export const AttackRunStartResponseSchema = z.object({
  type: z.literal("attack.run.start.response"),
  payload: RunPayloadSchema,
});

export const AttackRunPauseResponseSchema = z.object({
  type: z.literal("attack.run.pause.response"),
  payload: RunPayloadSchema,
});

export const AttackRunResumeResponseSchema = z.object({
  type: z.literal("attack.run.resume.response"),
  payload: RunPayloadSchema,
});

export const AttackRunCancelResponseSchema = z.object({
  type: z.literal("attack.run.cancel.response"),
  payload: RunPayloadSchema,
});

export const AttackRunDesktopInputSetResponseSchema = z.object({
  type: z.literal("attack.run.desktop_input.set.response"),
  payload: RunPayloadSchema,
});

export const AttackRunGetResponseSchema = z.object({
  type: z.literal("attack.run.get.response"),
  payload: z.object({
    requestId: z.string(),
    run: AttackRunSchema,
    audit: z.array(AttackAuditEntrySchema),
  }),
});

export const AttackRunListResponseSchema = z.object({
  type: z.literal("attack.run.list.response"),
  payload: z.object({ requestId: z.string(), runs: z.array(AttackRunSchema) }),
});

export const AttackFindingListResponseSchema = z.object({
  type: z.literal("attack.finding.list.response"),
  payload: z.object({ requestId: z.string(), findings: z.array(FindingSchema) }),
});

export const AttackFindingGetResponseSchema = z.object({
  type: z.literal("attack.finding.get.response"),
  payload: z.object({ requestId: z.string(), finding: FindingSchema }),
});

export const AttackFindingUpdateResponseSchema = z.object({
  type: z.literal("attack.finding.update.response"),
  payload: z.object({ requestId: z.string(), finding: FindingSchema }),
});

export const AttackAuditRecordResponseSchema = z.object({
  type: z.literal("attack.audit.record.response"),
  payload: z.object({ requestId: z.string() }),
});

// Pushed to every connected client. Screenshot bytes are left out; fetch them with finding.get.
export const AttackRunChangedSchema = z.object({
  type: z.literal("attack.run.changed"),
  payload: z.object({ run: AttackRunSchema }),
});

export const AttackFindingChangedSchema = z.object({
  type: z.literal("attack.finding.changed"),
  payload: z.object({ finding: FindingSchema }),
});

export const AttackCoverageRecordResponseSchema = z.object({
  type: z.literal("attack.coverage.record.response"),
  payload: z.object({ requestId: z.string(), route: AttackCoverageRouteSchema }),
});

export const AttackCoverageGetResponseSchema = z.object({
  type: z.literal("attack.coverage.get.response"),
  payload: z.object({ requestId: z.string(), coverage: AttackCoverageSchema }),
});

export const AttackFindingMergeResponseSchema = z.object({
  type: z.literal("attack.finding.merge.response"),
  payload: z.object({ requestId: z.string(), finding: FindingSchema }),
});

// Pushed at most once a second per run.
export const AttackCoverageChangedSchema = z.object({
  type: z.literal("attack.coverage.changed"),
  payload: z.object({ runId: z.string(), coverage: AttackCoverageSchema }),
});

export const AttackDesktopActionPushSchema = z.object({
  type: z.literal("attack.desktop.action"),
  payload: z.object({ action: AttackDesktopActionSchema }),
});

export const AttackScheduleListRequestSchema = z.object({
  type: z.literal("attack.schedule.list.request"),
  requestId: z.string(),
  workspaceId: z.string().optional(),
});

export const AttackScheduleSaveRequestSchema = z.object({
  type: z.literal("attack.schedule.save.request"),
  requestId: z.string(),
  schedule: AttackScheduleInputSchema,
});

export const AttackScheduleDeleteRequestSchema = z.object({
  type: z.literal("attack.schedule.delete.request"),
  requestId: z.string(),
  scheduleId: z.string(),
});

export const AttackScheduleRunNowRequestSchema = z.object({
  type: z.literal("attack.schedule.run_now.request"),
  requestId: z.string(),
  scheduleId: z.string(),
});

// `audit` is each listed schedule's newest fire-log entries, oldest first.
export const AttackScheduleListResponseSchema = z.object({
  type: z.literal("attack.schedule.list.response"),
  payload: z.object({
    requestId: z.string(),
    schedules: z.array(AttackScheduleSchema),
    audit: z.array(AttackScheduleAuditEntrySchema),
  }),
});

export const AttackScheduleSaveResponseSchema = z.object({
  type: z.literal("attack.schedule.save.response"),
  payload: z.object({ requestId: z.string(), schedule: AttackScheduleSchema }),
});

export const AttackScheduleDeleteResponseSchema = z.object({
  type: z.literal("attack.schedule.delete.response"),
  payload: z.object({ requestId: z.string() }),
});

// The fire attempt's audit entry: a started run carries its id, a skipped one says why.
export const AttackScheduleRunNowResponseSchema = z.object({
  type: z.literal("attack.schedule.run_now.response"),
  payload: z.object({ requestId: z.string(), entry: AttackScheduleAuditEntrySchema }),
});
