import { useMemo } from "react";
import { PARENT_AGENT_ID_LABEL } from "@pimi/protocol/agent-labels";
import type { AttackRun } from "@pimi/protocol/attack/types";
import { useBrowserStore, type BrowserRecord } from "@/desktop/browser/store";
import { useSessionStore, type Agent } from "@/stores/session-store";

export type AttackTileState = "waiting" | "working" | "idle" | "failed" | "done";

export interface AttackRunAgent {
  agent: Agent;
  isLead: boolean;
  role: string;
  state: AttackTileState;
  browsers: BrowserRecord[];
}

const PROFILE_PREFIX = /^attack\s+/i;

function roleOf(agent: Agent, isLead: boolean): string {
  const name = agent.profile?.name?.replace(PROFILE_PREFIX, "").trim();
  if (name) return name.charAt(0).toUpperCase() + name.slice(1);
  return isLead ? "Coordinator" : (agent.title ?? "Agent");
}

function stateOf(agent: Agent, runActive: boolean): AttackTileState {
  if (agent.pendingPermissions.length > 0) return "waiting";
  if (agent.status === "error") return "failed";
  if (
    agent.turn.phase === "open" ||
    agent.status === "running" ||
    agent.status === "initializing"
  ) {
    return runActive ? "working" : "done";
  }
  return runActive ? "idle" : "done";
}

/**
 * The lead and every agent whose parent chain reaches it, with the browser tabs each one opened
 * during this run. Nothing from an earlier run appears: membership comes from the run's lead id
 * and the tabs' recorded run id.
 */
export function useAttackRunAgents(serverId: string, run: AttackRun | null): AttackRunAgent[] {
  const agents = useSessionStore((state) => state.sessions[serverId]?.agents);
  const browsersById = useBrowserStore((state) => state.browsersById);
  const leadId = run?.leadAgentId ?? null;
  const runId = run?.id ?? null;
  const runActive = run !== null && (run.status === "running" || run.status === "paused");
  return useMemo(() => {
    if (!agents || !leadId || !runId) return [];
    const members = new Map<string, boolean>();
    const belongs = (agentId: string): boolean => {
      const known = members.get(agentId);
      if (known !== undefined) return known;
      members.set(agentId, false);
      let current: string | null = agentId;
      let found = false;
      for (let depth = 0; current && depth < 8; depth += 1) {
        if (current === leadId) {
          found = true;
          break;
        }
        const parent: string | undefined = agents.get(current)?.labels[PARENT_AGENT_ID_LABEL];
        current = parent ?? null;
      }
      members.set(agentId, found);
      return found;
    };
    const rows: AttackRunAgent[] = [];
    for (const agent of agents.values()) {
      if (agent.archivedAt || !belongs(agent.id)) continue;
      const isLead = agent.id === leadId;
      rows.push({
        agent,
        isLead,
        role: roleOf(agent, isLead),
        state: stateOf(agent, runActive),
        browsers: Object.values(browsersById)
          .filter((record) => record.owner?.runId === runId && record.owner.agentId === agent.id)
          .sort((a, b) => a.createdAt - b.createdAt),
      });
    }
    return rows.sort(
      (a, b) =>
        Number(b.isLead) - Number(a.isLead) ||
        Number(a.state === "done") - Number(b.state === "done") ||
        a.agent.createdAt.getTime() - b.agent.createdAt.getTime(),
    );
  }, [agents, browsersById, leadId, runActive, runId]);
}
