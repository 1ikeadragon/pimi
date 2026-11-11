import type { AgentProfile } from "@pimi/protocol/messages";
import { generateAgentProfileId } from "./profile-id";
import type { AgentProfileValue } from "./profile-form-model";

/**
 * Adds a profile, or replaces one with the form's value. The value omits cleared fields, so it
 * replaces rather than merges. A built-in keeps its key and is marked edited, which stops the
 * daemon from replacing it when Pimi ships a newer version.
 */
export function upsertAgentProfile(
  profiles: readonly AgentProfile[],
  editingId: string | null,
  value: AgentProfileValue,
): AgentProfile[] {
  if (!editingId) {
    return [...profiles, { id: generateAgentProfileId(), ...value }];
  }
  return profiles.map((entry) =>
    entry.id === editingId
      ? {
          id: entry.id,
          ...value,
          ...(entry.builtin ? { builtin: { ...entry.builtin, edited: true } } : {}),
        }
      : entry,
  );
}

export interface AgentProfilesPatch {
  agentProfiles: AgentProfile[];
  agentProfilesRemovedBuiltins?: string[];
}

/** Deleting a built-in records its key so the daemon does not seed it again. */
export function buildDeleteProfilePatch(input: {
  profiles: readonly AgentProfile[];
  removedBuiltins: readonly string[];
  profileId: string;
}): AgentProfilesPatch {
  const profile = input.profiles.find((entry) => entry.id === input.profileId);
  const key = profile?.builtin?.key;
  return {
    agentProfiles: input.profiles.filter((entry) => entry.id !== input.profileId),
    ...(key && !input.removedBuiltins.includes(key)
      ? { agentProfilesRemovedBuiltins: [...input.removedBuiltins, key] }
      : {}),
  };
}

/**
 * Resetting a built-in removes the edited copy without recording its key; the daemon then seeds
 * the shipped version back under the same id.
 */
export function buildResetProfilePatch(input: {
  profiles: readonly AgentProfile[];
  profileId: string;
}): AgentProfilesPatch {
  return { agentProfiles: input.profiles.filter((entry) => entry.id !== input.profileId) };
}
