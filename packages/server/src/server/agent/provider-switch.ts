import type { AgentProviderSwitchMarker } from "@pimi/protocol/agent-types";
import {
  filterSelectableAgentModels,
  type AgentProvider,
  type AgentTimelineItem,
} from "./agent-sdk-types.js";
import type { ProviderSnapshotManager } from "./provider-snapshot-manager.js";

export type AgentProviderSwitchErrorCode =
  | "agent_not_switchable"
  | "same_provider"
  | "unknown_provider"
  | "provider_disabled"
  | "provider_unavailable"
  | "unknown_model"
  | "switch_failed";

export class AgentProviderSwitchError extends Error {
  constructor(
    public readonly code: AgentProviderSwitchErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AgentProviderSwitchError";
  }
}

/** A provider and the settings a brand-new agent on it would start with. */
export interface AgentProviderSwitchTarget {
  provider: AgentProvider;
  model?: string;
  modeId?: string;
  featureValues?: Record<string, unknown>;
  providerLabel?: string;
  modelLabel?: string;
}

export interface ResolveAgentProviderSwitchTargetInput {
  providerSnapshotManager: Pick<
    ProviderSnapshotManager,
    "hasProvider" | "getProvider" | "resolveCreateConfig"
  >;
  provider: AgentProvider;
  model: string | undefined;
  cwd: string;
}

/**
 * Checks the requested provider and model against what the host offers, then
 * resolves mode and feature defaults the way agent creation does.
 */
export async function resolveAgentProviderSwitchTarget(
  input: ResolveAgentProviderSwitchTargetInput,
): Promise<AgentProviderSwitchTarget> {
  const { providerSnapshotManager, provider, cwd } = input;
  const requestedModel = input.model?.trim() || undefined;
  if (!providerSnapshotManager.hasProvider(provider)) {
    throw new AgentProviderSwitchError(
      "unknown_provider",
      `Provider '${provider}' is not configured`,
    );
  }
  const entry = await providerSnapshotManager.getProvider({ provider, cwd, wait: true });
  if (!entry.enabled) {
    throw new AgentProviderSwitchError("provider_disabled", `Provider '${provider}' is disabled`);
  }
  if (entry.status !== "ready") {
    throw new AgentProviderSwitchError(
      "provider_unavailable",
      entry.status === "error" && entry.error
        ? entry.error
        : `Provider '${provider}' is not available`,
    );
  }
  const models = filterSelectableAgentModels(entry.models);
  const selectedModel = requestedModel
    ? models.find((model) => model.id === requestedModel || model.aliases?.includes(requestedModel))
    : (models.find((model) => model.isDefault) ?? models[0]);
  if (requestedModel && !selectedModel) {
    throw new AgentProviderSwitchError(
      "unknown_model",
      `Model '${requestedModel}' is not available for provider '${provider}'`,
    );
  }
  const defaults = await providerSnapshotManager.resolveCreateConfig({
    cwd,
    provider,
    requestedMode: undefined,
    featureValues: undefined,
    parent: null,
    unattended: false,
  });
  return {
    provider,
    model: requestedModel ?? selectedModel?.id,
    modeId: defaults.modeId,
    featureValues: defaults.featureValues,
    providerLabel: entry.label,
    modelLabel: selectedModel?.label,
  };
}

export function describeEndpoint(endpoint: AgentProviderSwitchMarker["from"]): string {
  const provider = endpoint.providerLabel ?? endpoint.provider;
  const model = endpoint.modelLabel ?? endpoint.model;
  return model ? `${provider} · ${model}` : provider;
}

export type ProviderSwitchTimelineItem = Extract<AgentTimelineItem, { type: "notification" }>;

/** The message is what a client without marker rendering shows. */
export function buildProviderSwitchTimelineItem(
  marker: AgentProviderSwitchMarker,
): ProviderSwitchTimelineItem {
  return {
    type: "notification",
    level: "info",
    message:
      marker.reason === "limit"
        ? `${marker.from.providerLabel ?? marker.from.provider} hit its limit. Continued on ${describeEndpoint(marker.to)}`
        : `Switched from ${describeEndpoint(marker.from)} to ${describeEndpoint(marker.to)}`,
    providerSwitch: marker,
  };
}

export function isProviderSwitchTimelineItem(
  item: AgentTimelineItem,
): item is ProviderSwitchTimelineItem {
  return item.type === "notification" && item.providerSwitch !== undefined;
}

const CARRIED_CONTEXT_BLOCK = /<chat-history-summary>\n[\s\S]*\n<\/chat-history-summary>\n*/;

/**
 * A provider echoes or replays the whole prompt it was sent, including the
 * conversation summary the daemon attached for it. The summary is delivery
 * context, so it stays out of the visible message.
 */
export function withoutCarriedContext(item: AgentTimelineItem): AgentTimelineItem {
  if (item.type !== "user_message" || !item.text.includes("<chat-history-summary>")) return item;
  const text = item.text.replace(CARRIED_CONTEXT_BLOCK, "").trim();
  return text ? { ...item, text } : item;
}
