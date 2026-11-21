import { z } from "zod";

// Recap: a profile of how the user worked with their agents over a period, read from the chat
// timelines this host stores. The client picks the period in its own time zone and sends its
// bounds; `timezoneOffsetMinutes` (minutes east of UTC) decides where hours and days start.
const RecapPeriodFields = {
  startMs: z.number(),
  endMs: z.number(),
  timezoneOffsetMinutes: z.number(),
  requestId: z.string(),
};

export const RecapGetRequestSchema = z.object({
  type: z.literal("recap.get.request"),
  ...RecapPeriodFields,
});

export const RecapNarrativeGenerateRequestSchema = z.object({
  type: z.literal("recap.narrative.generate.request"),
  ...RecapPeriodFields,
});

const RecapChatRefSchema = z.object({
  agentId: z.string(),
  workspaceId: z.string().nullable(),
  title: z.string().nullable(),
});

export const RecapStatsSchema = z.object({
  // Prompts the user typed into top-level chats. Subagents, background and internal chats are
  // prompted by Pimi or another agent, not the user, so they count as agents but not as prompts.
  prompts: z.number(),
  chats: z.number(),
  agents: z.number(),
  subagents: z.number(),
  // Most agents with a turn in progress at the same moment.
  peakParallel: z.number(),
  // The longest single turn: one prompt to the agent's last output before the next prompt.
  longestRun: RecapChatRefSchema.extend({ ms: z.number() }).nullable(),
  // Summed turn time across agents, and the wall-clock time with at least one turn running.
  agentMs: z.number(),
  activeMs: z.number(),
  // From completed edit and write tool calls.
  linesAdded: z.number(),
  linesRemoved: z.number(),
  filesChanged: z.number(),
  // Top-level chats that produced a plan (a plan tool call), out of `chats`.
  plannedChats: z.number(),
  // Local hour (0-23) and local day (YYYY-MM-DD) with the most prompts.
  peakHour: z.number().nullable(),
  busiestDay: z.object({ day: z.string(), prompts: z.number() }).nullable(),
  // The prompt sent most often, when one was sent at least twice.
  goToPrompt: z.object({ text: z.string(), count: z.number() }).nullable(),
  shortestPrompt: z.string().nullable(),
  thanks: z.number(),
  avgPromptWords: z.number().nullable(),
  // Prompts by the model of the chat they went to.
  models: z.array(z.object({ provider: z.string(), model: z.string(), prompts: z.number() })),
  tools: z.array(z.object({ name: z.string(), calls: z.number() })),
  projects: z.array(z.object({ project: z.string(), chats: z.number(), prompts: z.number() })),
  topChats: z.array(
    RecapChatRefSchema.extend({
      project: z.string().nullable(),
      prompts: z.number(),
      agentMs: z.number(),
    }),
  ),
  doneTasks: z.number(),
});

export const RecapNarrativeSchema = z.object({
  generatedAt: z.number(),
  // "provider / model" that wrote it.
  model: z.string().nullable(),
  archetype: z.object({ name: z.string(), description: z.string() }),
  // How the user treats the agent, in a few words ("A thinking partner").
  relationship: z.string(),
  story: z.string(),
  built: z.array(z.string()),
  patterns: z.array(z.object({ name: z.string(), description: z.string() })),
  strengths: z.array(z.string()),
  growth: z.array(z.string()),
});

export const RecapSchema = z.object({
  stats: RecapStatsSchema,
  narrative: RecapNarrativeSchema.nullable(),
});

export const RecapGetResponseSchema = z.object({
  type: z.literal("recap.get.response"),
  payload: z.object({
    requestId: z.string(),
    error: z.string().nullable(),
    recap: RecapSchema.nullable(),
  }),
});

export const RecapNarrativeGenerateResponseSchema = z.object({
  type: z.literal("recap.narrative.generate.response"),
  payload: z.object({
    requestId: z.string(),
    error: z.string().nullable(),
    narrative: RecapNarrativeSchema.nullable(),
  }),
});

export type RecapStats = z.infer<typeof RecapStatsSchema>;
export type RecapNarrative = z.infer<typeof RecapNarrativeSchema>;
export type Recap = z.infer<typeof RecapSchema>;
