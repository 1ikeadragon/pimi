import { z } from "zod";
import {
  AttackAuditEntrySchema,
  AttackRunDefinitionSchema,
  AttackRunSchema,
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
});

export const AttackRunCancelRequestSchema = z.object({
  type: z.literal("attack.run.cancel.request"),
  ...RunIdRequestShape,
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
