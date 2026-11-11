import { useCallback } from "react";
import type { AgentProfile } from "@pimi/protocol/messages";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import type { AgentProfilesPatch } from "./profile-list";

export interface UseAgentProfilesResult {
  /** `null` until the daemon config has arrived. */
  profiles: AgentProfile[] | null;
  /** Keys of built-in profiles the user deleted on this host. */
  removedBuiltins: string[];
  /** Writes the whole list; there is no per-profile RPC. */
  saveProfiles: (next: AgentProfile[]) => Promise<void>;
  /** Writes the list and, for a deleted built-in, the removed keys in one patch. */
  patchProfiles: (patch: AgentProfilesPatch) => Promise<void>;
}

export function useAgentProfiles(serverId: string | null): UseAgentProfilesResult {
  const { config, patchConfig } = useDaemonConfig(serverId);

  const saveProfiles = useCallback(
    async (next: AgentProfile[]) => {
      await patchConfig({ agentProfiles: next });
    },
    [patchConfig],
  );
  const patchProfiles = useCallback(
    async (patch: AgentProfilesPatch) => {
      await patchConfig({ ...patch });
    },
    [patchConfig],
  );

  return {
    profiles: config ? (config.agentProfiles ?? []) : null,
    removedBuiltins: config?.agentProfilesRemovedBuiltins ?? [],
    saveProfiles,
    patchProfiles,
  };
}
