import type { AgentProfile } from "@pimi/protocol/messages";

/**
 * A profile with its blank fields resolved away. Storage keeps every field
 * optional and lets the user clear one to an empty string; applying has to know
 * the difference between "set this" and "leave whatever is there alone", and
 * every consumer would otherwise re-derive the same trim-and-drop rules.
 */
export interface MaterializedAgentProfile {
  id: string;
  name: string;
  /** Empty for a profile that works with any provider: applying it keeps the current one. */
  provider: string;
  /** Empty when the profile names no model, meaning "leave the model alone". */
  modelId: string;
  modeId: string;
  thinkingOptionId: string;
  featureValues: Record<string, unknown>;
}

function trimmed(value: string | undefined): string {
  return value?.trim() ?? "";
}

export function materializeAgentProfile(profile: AgentProfile): MaterializedAgentProfile {
  return {
    id: profile.id,
    name: profile.name,
    provider: trimmed(profile.provider),
    modelId: trimmed(profile.model),
    modeId: trimmed(profile.modeId),
    thinkingOptionId: trimmed(profile.thinkingOptionId),
    featureValues: profile.featureValues ?? {},
  };
}
