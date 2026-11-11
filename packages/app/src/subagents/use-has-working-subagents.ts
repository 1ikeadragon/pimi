import { getParentAgentIdFromLabels } from "@pimi/protocol/agent-labels";
import { useSessionStore } from "@/stores/session-store";

/** Whether a managed subagent of this agent is mid-turn, so Stop on the agent has work to stop. */
export function useHasWorkingSubagents(serverId: string, agentId: string | null | undefined) {
  return useSessionStore((state) => {
    if (!agentId) return false;
    for (const agent of state.sessions[serverId]?.agents.values() ?? []) {
      if (
        !agent.archivedAt &&
        (agent.status === "running" || agent.status === "initializing") &&
        getParentAgentIdFromLabels(agent.labels) === agentId
      )
        return true;
    }
    return false;
  });
}
