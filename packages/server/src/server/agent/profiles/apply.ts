import type { AgentProfile, AgentProfileRef } from "@pimi/protocol/agent-profile";

/** The launch settings a profile can supply. Every field the caller set wins. */
export interface ProfileLaunchSettings {
  provider?: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  systemPrompt?: string;
}

export interface AppliedProfile<T extends ProfileLaunchSettings> {
  settings: T;
  profile: AgentProfileRef;
}

/**
 * Fills unset launch settings from a profile and puts its instructions ahead of any system
 * prompt the caller passed. Model, mode, thinking and features are tied to a provider, so they
 * come from the profile only when the agent uses the profile's provider.
 */
export function applyAgentProfile<T extends ProfileLaunchSettings>(
  profile: AgentProfile,
  settings: T,
): AppliedProfile<T> {
  const provider = settings.provider?.trim() || profile.provider;
  const sameProvider = Boolean(profile.provider) && provider === profile.provider;
  const instructions = profile.instructions?.trim();
  const systemPrompt =
    [instructions, settings.systemPrompt?.trim()].filter(Boolean).join("\n\n") || undefined;
  return {
    settings: {
      ...settings,
      ...(provider ? { provider } : {}),
      ...(sameProvider
        ? {
            model: settings.model ?? profile.model,
            modeId: settings.modeId ?? profile.modeId,
            thinkingOptionId: settings.thinkingOptionId ?? profile.thinkingOptionId,
            featureValues: settings.featureValues ?? profile.featureValues,
          }
        : {}),
      ...(systemPrompt ? { systemPrompt } : {}),
    },
    profile: { id: profile.id, name: profile.name },
  };
}
