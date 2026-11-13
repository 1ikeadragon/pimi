import type { AgentMode, AgentProvider } from "../agent-sdk-types.js";

/** A router provider can list hundreds of models, which overflows an agent's tool output limit. */
export const LIST_MODELS_LIMIT = 50;

export interface ProviderSummary {
  id: AgentProvider;
  label: string;
  description: string;
  enabled: boolean;
  modes: AgentMode[];
  status: string;
  error?: string;
}

export function toProviderSummary(entry: {
  provider: AgentProvider;
  label?: string;
  description?: string;
  enabled: boolean;
  modes?: AgentMode[];
  status: string;
  error?: string;
}): ProviderSummary {
  return {
    id: entry.provider,
    label: entry.label ?? entry.provider,
    description: entry.description ?? "",
    enabled: entry.enabled,
    modes: entry.modes ?? [],
    status: entry.status === "ready" ? "available" : entry.status,
    ...(entry.error ? { error: entry.error } : {}),
  };
}

/** Filters by query, lists the default model first, and caps the result at LIST_MODELS_LIMIT. */
export function limitModelList<
  T extends { id: string; label?: string | null; isDefault?: boolean },
>(provider: string, all: readonly T[], query: string | undefined) {
  const needle = query?.trim().toLowerCase();
  const matched = needle
    ? all.filter((model) => `${model.id}\n${model.label ?? ""}`.toLowerCase().includes(needle))
    : all;
  const models = [
    ...matched.filter((model) => model.isDefault),
    ...matched.filter((model) => !model.isDefault),
  ].slice(0, LIST_MODELS_LIMIT);
  return {
    provider,
    models,
    total: matched.length,
    ...(models.length < matched.length
      ? {
          guidance: `Showing ${models.length} of ${matched.length} models. Pass query to narrow by id or label.`,
        }
      : {}),
  };
}
