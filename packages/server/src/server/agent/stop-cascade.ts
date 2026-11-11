import type { Logger } from "pino";
import {
  getParentAgentIdFromLabels,
  STOPPED_BY_AGENT_ID_LABEL,
  STOPPED_WITH_SUBAGENTS_LABEL,
  type StoppedWithSubagents,
} from "@pimi/protocol/agent-labels";
import type {
  AgentLabelPatch,
  AgentManager,
  AgentRunCancellationResult,
  ManagedAgent,
} from "./agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";
import { sendPromptToAgent } from "./agent-prompt.js";

/**
 * Stop on an agent reaches the subagents it created. Each working descendant is marked with the
 * stopped agent's ID before it is interrupted, so its finish subscription treats the cancel as a
 * pause instead of waking the parent, and Resume knows which agents to restart.
 */

export const RESUME_AFTER_STOP_PROMPT = "Continue where you left off.";

interface StopCascadeManager {
  listAgents(): Pick<ManagedAgent, "id" | "labels">[];
  hasInFlightRun(agentId: string): boolean;
  cancelAgentRun(agentId: string): Promise<AgentRunCancellationResult>;
  patchLabels(agentId: string, patch: AgentLabelPatch): Promise<void>;
}

interface StopCascadeDependencies {
  agentManager: StopCascadeManager;
  agentStorage: { listActive(): Promise<StoredAgentRecord[]> };
  logger: Logger;
}

async function collectDescendantIds(
  deps: StopCascadeDependencies,
  rootAgentId: string,
): Promise<string[]> {
  const childrenByParent = new Map<string, Set<string>>();
  const link = (agentId: string, labels: Record<string, unknown> | null | undefined) => {
    const parentId = getParentAgentIdFromLabels(labels);
    if (!parentId) return;
    const children = childrenByParent.get(parentId) ?? new Set<string>();
    children.add(agentId);
    childrenByParent.set(parentId, children);
  };
  for (const record of await deps.agentStorage.listActive()) {
    if (!record.internal) link(record.id, record.labels);
  }
  for (const agent of deps.agentManager.listAgents()) link(agent.id, agent.labels);

  const descendants: string[] = [];
  const visited = new Set<string>([rootAgentId]);
  const queue = [rootAgentId];
  while (queue.length > 0) {
    const parentId = queue.shift()!;
    for (const childId of childrenByParent.get(parentId) ?? []) {
      if (visited.has(childId)) continue;
      visited.add(childId);
      descendants.push(childId);
      queue.push(childId);
    }
  }
  return descendants;
}

/**
 * Marks and interrupts every working descendant of `agentId`. The caller has already
 * interrupted (or decided not to interrupt) `agentId` itself. Returns how many were stopped.
 */
export async function stopWorkingSubagents(
  deps: StopCascadeDependencies,
  input: { agentId: string; wasMidTurn: boolean },
): Promise<number> {
  const working = (await collectDescendantIds(deps, input.agentId)).filter((id) =>
    deps.agentManager.hasInFlightRun(id),
  );
  if (working.length === 0) {
    return 0;
  }

  // Mark before interrupting: the finish subscription reads the marker on the cancel event.
  await Promise.all(
    working.map((id) =>
      deps.agentManager.patchLabels(id, { [STOPPED_BY_AGENT_ID_LABEL]: input.agentId }),
    ),
  );
  const results = await Promise.allSettled(
    working.map((id) => deps.agentManager.cancelAgentRun(id)),
  );

  let stopped = 0;
  for (const [index, result] of results.entries()) {
    const id = working[index]!;
    if (result.status === "fulfilled" && result.value.status === "settled") {
      stopped += 1;
      continue;
    }
    // Still running, or finished on its own first: its next finish must reach the parent.
    deps.logger.warn(
      {
        agentId: id,
        stoppedBy: input.agentId,
        outcome: result.status === "fulfilled" ? result.value.status : "error",
        err: result.status === "rejected" ? result.reason : undefined,
      },
      "Stop did not stop a working subagent",
    );
    await deps.agentManager.patchLabels(id, { [STOPPED_BY_AGENT_ID_LABEL]: null });
  }

  if (stopped > 0) {
    const state: StoppedWithSubagents = input.wasMidTurn ? "mid-turn" : "idle";
    await deps.agentManager.patchLabels(input.agentId, { [STOPPED_WITH_SUBAGENTS_LABEL]: state });
  }
  return stopped;
}

/**
 * Sends each subagent that `agentId`'s Stop stopped a short continue prompt, then the agent
 * itself when its own turn was interrupted.
 */
export async function resumeStoppedSubagents(
  deps: { agentManager: AgentManager; agentStorage: AgentStorage; logger: Logger },
  agentId: string,
): Promise<{ resumed: number }> {
  const held = new Set<string>();
  for (const record of await deps.agentStorage.listActive()) {
    if (record.labels?.[STOPPED_BY_AGENT_ID_LABEL] === agentId) held.add(record.id);
  }
  for (const agent of deps.agentManager.listAgents()) {
    if (agent.labels[STOPPED_BY_AGENT_ID_LABEL] === agentId) held.add(agent.id);
  }
  const parentLabels =
    deps.agentManager.getAgent(agentId)?.labels ?? (await deps.agentStorage.get(agentId))?.labels;
  const parentState = parentLabels?.[STOPPED_WITH_SUBAGENTS_LABEL];

  const clear: AgentLabelPatch = {
    [STOPPED_BY_AGENT_ID_LABEL]: null,
    [STOPPED_WITH_SUBAGENTS_LABEL]: null,
  };
  // Clear first so a second press cannot send a second continue prompt.
  await Promise.all([...held].map((id) => deps.agentManager.patchLabels(id, clear)));
  if (parentState) {
    await deps.agentManager.patchLabels(agentId, { [STOPPED_WITH_SUBAGENTS_LABEL]: null });
  }

  const send = (id: string) =>
    sendPromptToAgent({
      agentId: id,
      prompt: RESUME_AFTER_STOP_PROMPT,
      agentManager: deps.agentManager,
      agentStorage: deps.agentStorage,
      logger: deps.logger,
      unarchive: false,
    });
  const results = await Promise.allSettled(
    [...held].filter((id) => !deps.agentManager.hasInFlightRun(id)).map(send),
  );
  const failures = results.filter((result) => result.status === "rejected");
  for (const failure of failures) {
    deps.logger.warn({ err: failure.reason, agentId }, "Resume failed for a stopped subagent");
  }
  if (parentState === "mid-turn" && !deps.agentManager.hasInFlightRun(agentId)) {
    await send(agentId);
  }
  if (failures.length > 0) {
    throw new Error(`${failures.length} of ${held.size} subagents did not resume`);
  }
  return { resumed: held.size };
}
