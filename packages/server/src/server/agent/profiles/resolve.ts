import type { AgentProfile } from "@pimi/protocol/agent-profile";

/** Finds a profile by id, then by exact name, then by name ignoring case. */
export function findAgentProfile(
  profiles: readonly AgentProfile[],
  idOrName: string,
): AgentProfile | null {
  const wanted = idOrName.trim();
  if (!wanted) return null;
  const lower = wanted.toLowerCase();
  return (
    profiles.find((profile) => profile.id === wanted) ??
    profiles.find((profile) => profile.name === wanted) ??
    profiles.find((profile) => profile.name.toLowerCase() === lower) ??
    null
  );
}

export function requireAgentProfile(
  profiles: readonly AgentProfile[],
  idOrName: string,
): AgentProfile {
  const profile = findAgentProfile(profiles, idOrName);
  if (!profile) {
    const names = profiles.map((entry) => entry.name).join(", ");
    throw new Error(
      `Unknown agent profile: ${idOrName}.${names ? ` Profiles on this host: ${names}.` : ""}`,
    );
  }
  return profile;
}
