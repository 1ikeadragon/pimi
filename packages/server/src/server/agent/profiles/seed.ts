// Keeps the built-in agent profiles present in `daemon.agentProfiles`.
//
// - A built-in missing from the list is added, unless its key is in `removedBuiltins` (the user
//   deleted it). "Reset to default" in the app is therefore "remove it without recording the key".
// - An unedited built-in whose shipped version rose is replaced in place, keeping its position.
// - An edited built-in (`builtin.edited`) is left alone.
import type { AgentProfile } from "@pimi/protocol/agent-profile";
import type { MutableDaemonConfig } from "@pimi/protocol/messages";
import type { DaemonConfigStore } from "../../daemon-config-store.js";
import { BUILTIN_AGENT_PROFILES } from "./builtin-profiles.js";

interface SeedBuiltinProfilesInput {
  profiles: readonly AgentProfile[];
  removedBuiltins: readonly string[];
}

/** Returns the seeded list, or null when nothing needs to change. */
export function seedBuiltinProfiles(input: SeedBuiltinProfilesInput): AgentProfile[] | null {
  const removed = new Set(input.removedBuiltins);
  const shipped = new Map(
    BUILTIN_AGENT_PROFILES.map((profile) => [profile.builtin?.key ?? profile.id, profile]),
  );
  let changed = false;
  const present = new Set<string>();
  const next = input.profiles.map((profile) => {
    const key = profile.builtin?.key;
    if (!key) return profile;
    present.add(key);
    const latest = shipped.get(key);
    if (!latest?.builtin || profile.builtin?.edited) return profile;
    if (latest.builtin.version <= (profile.builtin?.version ?? 0)) return profile;
    changed = true;
    return { ...latest, id: profile.id };
  });
  for (const [key, profile] of shipped) {
    if (present.has(key) || removed.has(key)) continue;
    if (next.some((existing) => existing.id === profile.id)) continue;
    changed = true;
    next.push({ ...profile });
  }
  return changed ? next : null;
}

interface SeedLogger {
  warn(details: object, message: string): void;
}

/** Seeds at startup and again after every config change that drops a built-in. */
export function keepBuiltinProfilesSeeded(store: DaemonConfigStore, logger: SeedLogger): void {
  function seed(config: MutableDaemonConfig): void {
    if (!seedFromConfig(config)) return;
    void store
      .patch((current) => {
        const next = seedFromConfig(current);
        return next ? { agentProfiles: next } : {};
      })
      .catch((error: unknown) => {
        logger.warn({ err: error }, "Failed to seed built-in agent profiles");
      });
  }
  seed(store.get());
  store.onChange((config) => seed(config));
}

function seedFromConfig(config: MutableDaemonConfig): AgentProfile[] | null {
  return seedBuiltinProfiles({
    profiles: config.agentProfiles ?? [],
    removedBuiltins: config.agentProfilesRemovedBuiltins ?? [],
  });
}
