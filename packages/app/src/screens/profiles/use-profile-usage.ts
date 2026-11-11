import { useMemo } from "react";
import { useAutomations } from "@/hooks/use-automations";
import type { AggregatedAutomation } from "@/automations/aggregated-automations";

export interface ProfileUsage {
  /** Automations whose agent step names this profile, keyed by `serverId:profileId`. */
  byProfile: ReadonlyMap<string, AggregatedAutomation[]>;
}

export function profileUsageKey(serverId: string, profileId: string): string {
  return `${serverId}:${profileId}`;
}

/** Which automations start their agent with each profile, across every host. */
export function useProfileUsage(): ProfileUsage {
  const { loadState } = useAutomations();
  const automations = loadState.status === "loaded" ? loadState.data : null;
  return useMemo(() => {
    const byProfile = new Map<string, AggregatedAutomation[]>();
    for (const automation of automations ?? []) {
      const profileIds = new Set<string>();
      for (const node of automation.flow.nodes) {
        if (node.kind === "agent" && node.profileId) {
          profileIds.add(node.profileId);
        }
      }
      for (const profileId of profileIds) {
        const key = profileUsageKey(automation.serverId, profileId);
        byProfile.set(key, [...(byProfile.get(key) ?? []), automation]);
      }
    }
    return { byProfile };
  }, [automations]);
}
