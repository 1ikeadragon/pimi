import { z } from "zod";

export const LABEL_COLORS = [
  "violet",
  "sky",
  "emerald",
  "orange",
  "pink",
  "indigo",
  "teal",
  "red",
  "amber",
  "blue",
] as const;

export const LabelColorSchema = z.enum(LABEL_COLORS);
export type LabelColor = z.infer<typeof LabelColorSchema>;

/** One entry of the daemon's single label catalog. `id` is stable across rename and recolor. */
export const LabelSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: LabelColorSchema,
});
export type Label = z.infer<typeof LabelSchema>;

/**
 * Something a label can be attached to. `agent` covers a chat and a managed subagent (both are
 * agent records); `subagent` is a provider subagent that has no agent record of its own.
 */
export const LabelTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent"), agentId: z.string() }),
  z.object({ kind: z.literal("subagent"), parentAgentId: z.string(), subagentId: z.string() }),
  z.object({ kind: z.literal("task"), taskId: z.string() }),
]);
export type LabelTarget = z.infer<typeof LabelTargetSchema>;

/** Assignment store key: `agent:<agentId>`, `subagent:<parentAgentId>:<subagentId>`, `task:<taskId>`. */
export function labelTargetKey(target: LabelTarget): string {
  switch (target.kind) {
    case "agent":
      return `agent:${target.agentId}`;
    case "subagent":
      return `subagent:${target.parentAgentId}:${target.subagentId}`;
    case "task":
      return `task:${target.taskId}`;
  }
}

/** The full label set of one target. An absent assignment means no labels. */
export const LabelAssignmentSchema = z.object({
  target: LabelTargetSchema,
  labelIds: z.array(z.string()),
});
export type LabelAssignment = z.infer<typeof LabelAssignmentSchema>;

export function normalizeLabelName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

/** Names are unique case-insensitively. */
export function labelNameKey(name: string): string {
  return normalizeLabelName(name).toLowerCase();
}
