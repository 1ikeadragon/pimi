import { z } from "zod";

// Heartbeats take a cron cadence, a plain interval (`every`), or one time (`once`).
export const HeartbeatCadenceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("every"),
    everyMs: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("cron"),
    expression: z.string().trim().min(1),
    timezone: z.string().trim().min(1).optional(),
  }),
  z.object({ type: z.literal("once"), at: z.string() }),
]);
export type HeartbeatCadence = z.infer<typeof HeartbeatCadenceSchema>;

// A heartbeat sends a prompt back into one existing agent on a cadence. It is not an
// automation: it runs without approval and ends with its agent.
export const HeartbeatLastRunSchema = z.object({
  at: z.string(),
  status: z.enum(["succeeded", "failed"]),
  error: z.string().nullable(),
});
export type HeartbeatLastRun = z.infer<typeof HeartbeatLastRunSchema>;

export const HeartbeatSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  name: z.string().nullable(),
  prompt: z.string().min(1),
  cadence: HeartbeatCadenceSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  nextRunAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  maxRuns: z.number().int().positive().nullable(),
  runCount: z.number().int().nonnegative(),
  lastRun: HeartbeatLastRunSchema.nullable(),
});
export type Heartbeat = z.infer<typeof HeartbeatSchema>;
