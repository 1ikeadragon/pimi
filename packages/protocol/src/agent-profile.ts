import { z } from "zod";

/**
 * A named launch bundle: optional provider settings plus instructions for the
 * agent. Field names mirror `AgentSessionConfig` so applying a profile is a copy
 * rather than a translation table.
 *
 * `instructions` becomes the agent's system prompt, which a provider reads only
 * when the agent is created. Applying a profile to a running agent changes its
 * model, mode and thinking; the instructions reach only agents created with it.
 */
export const AgentProfileBuiltinSchema = z.object({
  key: z.string(),
  version: z.number().int().nonnegative(),
  /** Set once the user saves a change. An edited built-in is never replaced by a newer one. */
  edited: z.boolean().optional(),
});
export type AgentProfileBuiltin = z.infer<typeof AgentProfileBuiltinSchema>;

export const AgentProfileSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    /** A key into the client's icon registry, not a glyph. Unknown keys draw the default. */
    icon: z.string().optional(),
    /** An identity colour name shared with host badges. Unknown values draw unthemed. */
    color: z.string().optional(),
    /** Absent means "whatever provider is chosen where the profile is used". */
    provider: z.string().optional(),
    model: z.string().optional(),
    modeId: z.string().optional(),
    thinkingOptionId: z.string().optional(),
    featureValues: z.record(z.string(), z.unknown()).optional(),
    /** The agent's system prompt, applied when an agent is created with this profile. */
    instructions: z.string().optional(),
    /** Free text telling an orchestrating agent when to pick this profile ("When to use"). */
    notes: z.string().optional(),
    /** Present on profiles the daemon ships and seeds. */
    builtin: AgentProfileBuiltinSchema.optional(),
  })
  .passthrough();

/** What an agent records about the profile it was created with. */
export const AgentProfileRefSchema = z.object({ id: z.string(), name: z.string() });
export type AgentProfileRef = z.infer<typeof AgentProfileRefSchema>;

export type AgentProfile = z.infer<typeof AgentProfileSchema>;

export const AgentSkillSelectionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }).strict(),
  z.object({ mode: z.literal("custom"), skills: z.array(z.string()) }).strict(),
]);
export type AgentSkillSelection = z.infer<typeof AgentSkillSelectionSchema>;
