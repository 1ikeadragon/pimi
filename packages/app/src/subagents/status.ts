import type { Agent } from "@/stores/session-store";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { workspaceAgentStatus } from "@/utils/workspace-agent-activity";
import type { ProviderSubagentDescriptorPayload } from "@pimi/protocol/messages";

/**
 * What a child is doing, as every surface that shows one names it: the delegation card, the
 * subagents track and its pill, and the sidebar lineage.
 *
 * A child reports its own state, not whether anyone has read it, so there is no "ready to
 * review" here: the parent's own finish carries that news. A failed child follows its lifecycle
 * and stays failed until it is archived or runs again, so a failure is not lost to a glance.
 */
export type SubagentStatusBucket = Extract<
  SidebarStateBucket,
  "needs_input" | "failed" | "running" | "done"
>;

type ManagedSubagentStatusInput = Pick<
  Agent,
  "status" | "turn" | "backgroundWork" | "pendingPermissions" | "attentionReason"
>;

export function managedSubagentStatusBucket(
  agent: ManagedSubagentStatusInput,
): SubagentStatusBucket {
  if (agent.pendingPermissions.length > 0 || agent.attentionReason === "permission") {
    return "needs_input";
  }
  const status = workspaceAgentStatus(agent);
  if (status === "error") return "failed";
  if (status === "running" || status === "initializing" || (agent.backgroundWork?.count ?? 0) > 0) {
    return "running";
  }
  return "done";
}

export function providerSubagentStatusBucket(
  status: ProviderSubagentDescriptorPayload["status"],
): SubagentStatusBucket {
  if (status === "running") return "running";
  if (status === "failed") return "failed";
  return "done";
}

/** A child still worth a look outside its parent's track. */
export function isLiveSubagentStatus(bucket: SubagentStatusBucket): boolean {
  return bucket !== "done";
}

/** The sidebar's status-group names: one name per state across the app. */
export const SUBAGENT_STATUS_LABEL_KEYS = {
  needs_input: "sidebar.statusBucket.needsInput",
  failed: "sidebar.statusBucket.failed",
  running: "sidebar.statusBucket.working",
  done: "sidebar.statusBucket.done",
} as const satisfies Record<SubagentStatusBucket, string>;
