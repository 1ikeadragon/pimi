import { z } from "zod";
import { HeartbeatCadenceSchema, HeartbeatSchema } from "./types.js";

export const HeartbeatCreateRequestSchema = z.object({
  type: z.literal("heartbeat.create.request"),
  requestId: z.string(),
  agentId: z.string(),
  name: z.string().optional(),
  prompt: z.string().min(1),
  cadence: HeartbeatCadenceSchema,
  maxRuns: z.number().int().positive().optional(),
  expiresAt: z.string().optional(),
  runOnCreate: z.boolean().optional(),
});

export const HeartbeatUpdateRequestSchema = z.object({
  type: z.literal("heartbeat.update.request"),
  requestId: z.string(),
  heartbeatId: z.string(),
  cadence: HeartbeatCadenceSchema,
});

export const HeartbeatDeleteRequestSchema = z.object({
  type: z.literal("heartbeat.delete.request"),
  requestId: z.string(),
  heartbeatId: z.string(),
});

export const HeartbeatListRequestSchema = z.object({
  type: z.literal("heartbeat.list.request"),
  requestId: z.string(),
  agentId: z.string().optional(),
});

export const HeartbeatCreateResponseSchema = z.object({
  type: z.literal("heartbeat.create.response"),
  payload: z.object({ requestId: z.string(), heartbeat: HeartbeatSchema }),
});

export const HeartbeatUpdateResponseSchema = z.object({
  type: z.literal("heartbeat.update.response"),
  payload: z.object({ requestId: z.string(), heartbeat: HeartbeatSchema }),
});

export const HeartbeatDeleteResponseSchema = z.object({
  type: z.literal("heartbeat.delete.response"),
  payload: z.object({ requestId: z.string(), heartbeatId: z.string() }),
});

export const HeartbeatListResponseSchema = z.object({
  type: z.literal("heartbeat.list.response"),
  payload: z.object({ requestId: z.string(), heartbeats: z.array(HeartbeatSchema) }),
});
