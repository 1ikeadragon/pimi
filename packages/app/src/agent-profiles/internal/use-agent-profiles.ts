import { useCallback } from "react";
import type { AgentProfile } from "@pimi/protocol/messages";
import { useDaemonConfig } from "@/hooks/use-daemon-config";

export interface UseAgentProfilesResult {
  /** `null` until the daemon config has arrived. */
  profiles: AgentProfile[] | null;
  /** Writes the whole list; there is no per-profile RPC. */
  saveProfiles: (next: AgentProfile[]) => Promise<void>;
}

export function useAgentProfiles(serverId: string | null): UseAgentProfilesResult {
  const { config, patchConfig } = useDaemonConfig(serverId);

  const saveProfiles = useCallback(
    async (next: AgentProfile[]) => {
      await patchConfig({ agentProfiles: next });
    },
    [patchConfig],
  );

  return {
    profiles: config ? (config.agentProfiles ?? []) : null,
    saveProfiles,
  };
}
