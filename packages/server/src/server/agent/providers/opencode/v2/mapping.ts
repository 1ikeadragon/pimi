import type { AgentInfo, ModelInfo, ModelRef, SessionInfo } from "@opencode/client";
import type { AgentMode, AgentModelDefinition, AgentUsage } from "../../../agent-sdk-types.js";

export function modelRef(id: string, variant?: string | null): ModelRef {
  const slash = id.indexOf("/");
  if (slash < 1 || slash === id.length - 1)
    throw new Error(
      `OpenCode model "${id}" must be <provider>/<model>, for example opencode/big-pickle. With create_agent, pass provider "opencode/<provider>/<model>", for example opencode/opencode/big-pickle; list_models lists the ids.`,
    );
  return {
    providerID: id.slice(0, slash),
    id: id.slice(slash + 1),
    ...(variant ? { variant } : {}),
  };
}

// COMPAT(opencode 2.2.6 Model.small): the families OpenCode tries, in order, for a provider's
// small model. OpenCode exposes no route for it, so this mirrors its source.
const OPENCODE_SMALL_MODEL_FAMILIES = [
  "gpt-luna",
  "gemini-flash-lite",
  "gemini-flash",
  "claude-haiku",
];

/**
 * The models OpenCode itself would title a session with: the `title` agent's model (its
 * `small_model` config), else each provider's small model. OpenCode then falls back to the chat's
 * own model; Pimi never does, so a provider without one declares none.
 */
function openCodeSmallModels(models: ModelInfo[], agents: AgentInfo[]): Set<ModelInfo> {
  const configured = agents.find((agent) => agent.id === "title")?.model;
  if (configured) {
    return new Set(
      models.filter(
        (model) => model.providerID === configured.providerID && model.id === configured.id,
      ),
    );
  }
  const small = new Set<ModelInfo>();
  const textModels = models.filter(
    (model) =>
      model.enabled &&
      model.status === "active" &&
      model.capabilities.input.some((kind) => kind.startsWith("text")) &&
      model.capabilities.output.some((kind) => kind.startsWith("text")),
  );
  for (const providerID of new Set(textModels.map((model) => model.providerID))) {
    const own = textModels.filter((model) => model.providerID === providerID);
    const found = OPENCODE_SMALL_MODEL_FAMILIES.flatMap(
      (family) => own.find((model) => model.family === family) ?? [],
    )[0];
    if (found) small.add(found);
  }
  return small;
}

export function modelsFromV2(models: ModelInfo[], agents: AgentInfo[]): AgentModelDefinition[] {
  const small = openCodeSmallModels(models, agents);
  return models
    .filter((model) => model.enabled)
    .map((model) => ({
      provider: "opencode",
      id: `${model.providerID}/${model.id}`,
      label: model.name,
      isSmall: small.has(model) || undefined,
      contextWindowMaxTokens: model.limit.context,
      metadata: {
        providerId: model.providerID,
        modelId: model.id,
        supportsAttachments: model.capabilities.input.includes("image"),
        supportsToolCall: model.capabilities.tools,
        contextWindowMaxTokens: model.limit.context,
      },
      thinkingOptions: model.variants.map((variant) => ({ id: variant.id, label: variant.id })),
    }));
}

export function modesFromV2(agents: AgentInfo[]): AgentMode[] {
  return agents
    .filter((agent) => !agent.hidden && agent.mode !== "subagent")
    .map((agent) => ({ id: agent.id, label: agent.name, description: agent.description }));
}

export function usageFromV2(session: SessionInfo): AgentUsage {
  return {
    reportScope: "session",
    inputTokens: session.tokens.input,
    outputTokens: session.tokens.output,
    cachedInputTokens: session.tokens.cache.read,
    cacheWriteInputTokens: session.tokens.cache.write,
    totalCostUsd: session.cost,
  };
}
