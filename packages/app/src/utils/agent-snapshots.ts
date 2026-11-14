import type { AgentSnapshotPayload } from "@pimi/protocol/messages";
import type { AgentPermissionRequest } from "@pimi/protocol/agent-types";
import { getParentAddressFromLabels } from "@pimi/protocol/agent-labels";
import { TURN_LIVENESS_IDLE, type TurnLiveness } from "@/timeline/turn-liveness";
import type { Agent } from "@/stores/session-store";

function normalizeTurn(snapshot: AgentSnapshotPayload): TurnLiveness {
  if (!snapshot.activeTurn) return TURN_LIVENESS_IDLE;
  return {
    phase: "open",
    turnId: snapshot.activeTurn.turnId,
    startedAt: snapshot.activeTurn.startedAt ? new Date(snapshot.activeTurn.startedAt) : null,
    cancellationRequestId: null,
  };
}

function projectActiveTurn(agent: Agent): Pick<AgentSnapshotPayload, "activeTurn"> {
  if (agent.turn.phase === "idle") return { activeTurn: null };
  if (agent.turn.turnId === null) return {};
  return {
    activeTurn: {
      turnId: agent.turn.turnId,
      startedAt: agent.turn.startedAt?.toISOString() ?? null,
    },
  };
}

export function derivePendingPermissionKey(
  agentId: string,
  request: AgentPermissionRequest,
): string {
  const fallbackId =
    request.id ||
    (typeof request.metadata?.id === "string" ? request.metadata.id : undefined) ||
    request.name ||
    request.title ||
    `${request.kind}:${JSON.stringify(request.input ?? request.metadata ?? {})}`;

  return `${agentId}:${fallbackId}`;
}

export function projectAgentSnapshot(agent: Agent): AgentSnapshotPayload {
  return {
    id: agent.id,
    provider: agent.provider,
    cwd: agent.cwd,
    ...(agent.workspaceId ? { workspaceId: agent.workspaceId } : {}),
    model: agent.model,
    ...(agent.features ? { features: agent.features } : {}),
    thinkingOptionId: agent.thinkingOptionId ?? null,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
    lastUserMessageAt: agent.lastUserMessageAt?.toISOString() ?? null,
    status: agent.status,
    backgroundWork: agent.backgroundWork,
    ...projectActiveTurn(agent),
    capabilities: agent.capabilities,
    currentModeId: agent.currentModeId,
    availableModes: agent.availableModes,
    pendingPermissions: agent.pendingPermissions,
    persistence: agent.persistence,
    ...(agent.runtimeInfo ? { runtimeInfo: agent.runtimeInfo } : {}),
    ...(agent.lastUsage ? { lastUsage: agent.lastUsage } : {}),
    ...(agent.lastError ? { lastError: agent.lastError } : {}),
    title: agent.title,
    labels: agent.labels,
    requiresAttention: agent.requiresAttention ?? false,
    attentionReason: agent.attentionReason ?? null,
    attentionTimestamp: agent.attentionTimestamp?.toISOString() ?? null,
    archivedAt: agent.archivedAt?.toISOString() ?? null,
    ...(agent.background ? { background: true } : {}),
  };
}

export function normalizeAgentSnapshot(snapshot: AgentSnapshotPayload, serverId: string) {
  const createdAt = new Date(snapshot.createdAt);
  const updatedAt = new Date(snapshot.updatedAt);
  const lastUserMessageAt = snapshot.lastUserMessageAt
    ? new Date(snapshot.lastUserMessageAt)
    : null;
  const attentionTimestamp = snapshot.attentionTimestamp
    ? new Date(snapshot.attentionTimestamp)
    : null;
  const archivedAt = snapshot.archivedAt ? new Date(snapshot.archivedAt) : null;
  const parent = getParentAddressFromLabels(snapshot.labels, serverId);
  const parentAgentId = parent?.serverId === serverId ? parent.agentId : null;
  const turn = normalizeTurn(snapshot);

  return {
    serverId,
    id: snapshot.id,
    provider: snapshot.provider,
    status: snapshot.status,
    backgroundWork: snapshot.backgroundWork,
    turn,
    createdAt,
    updatedAt,
    lastUserMessageAt,
    lastActivityAt: updatedAt,
    capabilities: snapshot.capabilities,
    currentModeId: snapshot.currentModeId,
    availableModes: snapshot.availableModes ?? [],
    pendingPermissions: snapshot.pendingPermissions ?? [],
    persistence: snapshot.persistence ?? null,
    runtimeInfo: snapshot.runtimeInfo,
    lastUsage: snapshot.lastUsage,
    lastError: snapshot.lastError ?? null,
    title: snapshot.title ?? null,
    cwd: snapshot.cwd,
    workspaceId: snapshot.workspaceId,
    model: snapshot.model ?? null,
    features: snapshot.features,
    thinkingOptionId: snapshot.thinkingOptionId ?? null,
    profile: snapshot.profile ?? null,
    requiresAttention: snapshot.requiresAttention ?? false,
    attentionReason: snapshot.attentionReason ?? null,
    attentionTimestamp,
    archivedAt,
    background: snapshot.background === true,
    limitFallbackDisabled: snapshot.limitFallbackDisabled === true,
    parentAgentId,
    labels: snapshot.labels,
  };
}
