import type { Automation, AutomationAgentNode } from "@pimi/protocol/automation/types";
import { describeAutomationCwd } from "@/automations/automation-project-targets";

// One badge per automation. "pending", "active" and "paused" mirror the stored
// status; "failing" is a pause the daemon made after repeated failures; "expired"
// covers the gap between expiresAt passing and the daemon's next tick.
export type AutomationDerivedState =
  | "pending"
  | "active"
  | "paused"
  | "failing"
  | "expired"
  | "finished";

export type AutomationBucket = "runnable" | "ended";

export interface AutomationOriginAgent {
  title: string | null;
}

export interface ResolvedAutomation {
  state: AutomationDerivedState;
  bucket: AutomationBucket;
  /** The project name, or the shortened cwd. */
  projectLabel: string;
  provider: string | null;
  /** "Created by agent …" for automations an agent made, otherwise null. */
  originLabel: string | null;
}

export interface ResolveAutomationInput {
  automation: Automation;
  serverId: string;
  now: number;
  /** Client agent directory keyed by `${serverId}:${agentId}`. */
  agentsByKey: ReadonlyMap<string, AutomationOriginAgent>;
  /** Known project roots keyed by `${serverId}:${cwd}`. */
  projectNameByCwd: ReadonlyMap<string, string>;
}

export function automationAgentNode(automation: Automation): AutomationAgentNode | null {
  for (const node of automation.flow.nodes) {
    if (node.kind === "agent") {
      return node;
    }
  }
  return null;
}

function isExpired(automation: Automation, now: number): boolean {
  if (!automation.limits.expiresAt) {
    return false;
  }
  const expiresAt = Date.parse(automation.limits.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

function deriveState(automation: Automation, now: number): AutomationDerivedState {
  if (automation.status === "ended") {
    return "finished";
  }
  if (isExpired(automation, now)) {
    return "expired";
  }
  if (automation.status === "pending") {
    return "pending";
  }
  if (automation.status === "paused") {
    return automation.pausedReason === "failures" ? "failing" : "paused";
  }
  return "active";
}

function resolveOriginLabel(input: ResolveAutomationInput): string | null {
  const { origin } = input.automation;
  if (origin.kind === "compiled") {
    return "Compiled from a description";
  }
  if (origin.kind !== "agent") {
    return null;
  }
  const agent = input.agentsByKey.get(`${input.serverId}:${origin.agentId}`);
  const name = agent?.title?.trim() || `agent ${origin.agentId.slice(0, 7)}`;
  return `Created by ${agent?.title?.trim() ? `agent "${name}"` : name}`;
}

export function automationBucket(state: AutomationDerivedState): AutomationBucket {
  return state === "expired" || state === "finished" ? "ended" : "runnable";
}

export function resolveAutomation(input: ResolveAutomationInput): ResolvedAutomation {
  const state = deriveState(input.automation, input.now);
  return {
    state,
    bucket: automationBucket(state),
    projectLabel: describeAutomationCwd({
      serverId: input.serverId,
      cwd: input.automation.project.cwd,
      projectNameByCwd: input.projectNameByCwd,
    }),
    provider: automationAgentNode(input.automation)?.provider ?? null,
    originLabel: resolveOriginLabel(input),
  };
}
