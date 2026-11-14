import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Logger } from "pino";

import type { AgentModelDefinition } from "../../agent-sdk-types.js";
import {
  getClaudeCustomModelThinkingOptions,
  getClaudeManifestModels,
  normalizeClaudeManifestModelId,
  normalizeClaudeRuntimeModelId as normalizeClaudeManifestRuntimeModelId,
} from "./model-manifest.js";

const CLAUDE_SETTINGS_MODEL_ENV_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
] as const;

export function getClaudeModels(claudeCodeVersion?: string): AgentModelDefinition[] {
  return getClaudeManifestModels(claudeCodeVersion);
}

export function resolveConfiguredClaudeModel(model: AgentModelDefinition): AgentModelDefinition {
  if (model.thinkingOptions !== undefined) return model;

  const manifestModelId = normalizeClaudeManifestModelId(model.id);
  const manifestModel = manifestModelId
    ? getClaudeModels().find((candidate) => candidate.id === manifestModelId)
    : undefined;
  if (manifestModel) {
    return manifestModel.thinkingOptions
      ? { ...model, thinkingOptions: manifestModel.thinkingOptions }
      : model;
  }
  return { ...model, thinkingOptions: getClaudeCustomModelThinkingOptions() };
}

export function findClaudeModel(
  modelId: string | null | undefined,
): AgentModelDefinition | undefined {
  const normalizedModelId = normalizeClaudeRuntimeModelId(modelId);
  if (!normalizedModelId) {
    return undefined;
  }
  return getClaudeModels().find((model) => model.id === normalizedModelId);
}

export function getClaudeContextWindowMaxTokens(
  modelId: string | null | undefined,
): number | undefined {
  if (modelId?.trim().toLowerCase().endsWith("[1m]")) {
    return 1_000_000;
  }
  return findClaudeModel(modelId)?.contextWindowMaxTokens;
}

export async function getClaudeModelsWithSettings(
  logger: Logger,
  configDir: string,
  claudeCodeVersion?: string,
  discoveredModelIds: ReadonlySet<string> = new Set(),
): Promise<AgentModelDefinition[]> {
  const hardcodedModels = getClaudeManifestModels(claudeCodeVersion, discoveredModelIds);
  const settings = await readClaudeSettings(logger, configDir);
  const settingsModels = settings ? collectClaudeSettingsModels(logger, settings) : [];
  const models = [...hardcodedModels];

  for (const model of settingsModels) {
    const existingIndex = models.findIndex((candidate) => candidate.id === model.id);
    if (existingIndex !== -1) {
      const existing = models[existingIndex];
      if (existing?.isSelectable === false) {
        models[existingIndex] = { ...existing, ...model, isSelectable: true };
      }
      continue;
    }
    const manifestModel = hardcodedModels.find((candidate) => candidate.id === model.id);
    models.push(resolveConfiguredClaudeModel({ ...manifestModel, ...model }));
  }

  return settings ? applyClaudeConfiguredModelDefaults(models, settings) : models;
}

// Claude Code accepts a bare family alias such as "opus". The catalog is ordered newest first,
// so the alias maps to the first selectable, non-1M entry of that family.
function findClaudeConfiguredDefaultModel(
  models: AgentModelDefinition[],
  configuredModelId: string | undefined,
): AgentModelDefinition | undefined {
  if (!configuredModelId) return undefined;
  const selectable = models.filter((model) => model.isSelectable !== false);
  const exact = selectable.find(
    (model) => model.id === configuredModelId || model.aliases?.includes(configuredModelId),
  );
  if (exact && !/^(mythos|fable|opus|sonnet|haiku)$/i.test(configuredModelId)) return exact;
  const family = configuredModelId.toLowerCase();
  if (!/^(mythos|fable|opus|sonnet|haiku)$/.test(family)) return exact;
  return (
    selectable.find(
      (model) => model.id.startsWith(`claude-${family}-`) && !model.id.endsWith("[1m]"),
    ) ?? exact
  );
}

function applyClaudeConfiguredModelDefaults(
  models: AgentModelDefinition[],
  settings: Record<string, unknown>,
): AgentModelDefinition[] {
  const configuredModel = findClaudeConfiguredDefaultModel(
    models,
    readTrimmedString(settings.model),
  );
  const effortLevel = readTrimmedString(settings.effortLevel);
  const modelSettings = isRecord(settings.modelSettings) ? settings.modelSettings : {};

  return models.map((model) => {
    const next = { ...model };
    if (configuredModel) {
      next.isDefault = model === configuredModel ? true : undefined;
    }
    const perModel = [model.id, ...(model.aliases ?? [])]
      .map((key) => modelSettings[key])
      .find(isRecord);
    const level = readTrimmedString(perModel?.effortLevel) ?? effortLevel;
    if (level && model.thinkingOptions?.some((option) => option.id === level)) {
      next.defaultThinkingOptionId = level;
      next.thinkingOptions = model.thinkingOptions.map(({ isDefault: _drop, ...option }) =>
        option.id === level ? { ...option, isDefault: true } : option,
      );
    }
    return next;
  });
}

async function readClaudeSettings(
  logger: Logger,
  configDir: string,
): Promise<Record<string, unknown> | null> {
  const settingsPath = path.join(configDir, "settings.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  } catch (error) {
    logger.debug({ err: error, settingsPath }, "Failed to read Claude settings");
    return null;
  }
  if (!isRecord(parsed)) {
    logger.debug({ settingsPath }, "Claude settings.json is not an object");
    return null;
  }
  return parsed;
}

function collectClaudeSettingsModels(
  logger: Logger,
  settings: Record<string, unknown>,
): AgentModelDefinition[] {
  const models: AgentModelDefinition[] = [];
  addSettingsModel(models, settings.model, "model");

  const env = settings.env;
  if (env === undefined) {
    return models;
  }
  if (!isRecord(env)) {
    logger.debug("Claude settings.json env is not an object");
    return models;
  }

  for (const envKey of CLAUDE_SETTINGS_MODEL_ENV_KEYS) {
    addSettingsModel(models, env[envKey], `env.${envKey}`);
  }

  return models;
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function addSettingsModel(
  models: AgentModelDefinition[],
  value: unknown,
  settingsKey: string,
): void {
  if (typeof value !== "string") {
    return;
  }

  const id = value.trim();
  if (id.length === 0 || models.some((model) => model.id === id)) {
    return;
  }

  models.push({
    provider: "claude",
    id,
    label: id,
    description: `From Claude settings.json ${settingsKey}`,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize a runtime model string (from SDK init message) to a known model ID.
 * Handles the `[1m]` suffix that the SDK appends for 1M context sessions.
 */
export function normalizeClaudeRuntimeModelId(value: string | null | undefined): string | null {
  return normalizeClaudeManifestRuntimeModelId(value);
}

/**
 * Placeholder model values Claude Code writes on frames with no real inference behind them.
 * These are not models and must never be displayed.
 */
const CLAUDE_PLACEHOLDER_MODEL_IDS = new Set(["<synthetic>"]);

/**
 * Resolve a model id observed on a Claude assistant frame, for display.
 *
 * Prefers the manifest-normalized id so equivalent spellings collapse (a dated alias and a
 * gateway prefix are the same model), but falls back to the raw string when the manifest does
 * not know it. The fallback matters: Claude Code is an Anthropic-compatible client, so subagents
 * routinely report models that are not Anthropic's — Z.AI GLM ids via `ANTHROPIC_BASE_URL`
 * (docs/custom-providers.md) among them. Manifest-only resolution would blank the model for
 * exactly those users.
 *
 * A `[1m]` suffix is preserved where it names its own manifest entry. Models such as Fable 5
 * that only have a 1M entry normalize the retired suffixed spelling to the canonical ID.
 *
 * Returns null for placeholders and empty values, meaning "not observed".
 */
export function resolveObservedClaudeModelId(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || CLAUDE_PLACEHOLDER_MODEL_IDS.has(trimmed)) {
    return null;
  }
  return normalizeClaudeManifestRuntimeModelId(trimmed) ?? trimmed;
}
