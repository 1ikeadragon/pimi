import type { Logger } from "pino";
import { z } from "zod";
import type { AgentManager } from "../agent-manager.js";
import {
  generateStructuredAgentResponse,
  generateStructuredAgentResponseWithFallback,
} from "../agent-response-loop.js";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import {
  resolvePimiModel,
  type StructuredGenerationDaemonConfig,
} from "../structured-generation-providers.js";
import type { GenerateSummary, SummaryCall } from "./summarizer.js";

/**
 * The prompt asks for far less; models overshoot, and failing the whole job over length would
 * throw away a good summary. The message clips what it carries to HANDOFF_SUMMARY_MAX_CHARS.
 */
const SUMMARY_HARD_MAX_CHARS = 16_000;
const HandoffSummarySchema = z.object({
  summary: z.string().min(40).max(SUMMARY_HARD_MAX_CHARS),
});

export interface HandoffModelDeps {
  manager: AgentManager;
  providerSnapshotManager: Pick<ProviderSnapshotManager, "listProviders">;
  daemonConfig: () => StructuredGenerationDaemonConfig;
  logger: Logger;
}

export interface HandoffModelTarget {
  cwd: string;
  /** What the chat runs on after the switch: the last model tried by an automatic pick. */
  target: { provider: string; model?: string | null };
  /** The provider that hit its limit. A summary model on it would only burn the deadline. */
  excludeProvider?: string;
}

/**
 * Builds the model call behind a handoff summary: the `handoff` Pimi model feature, tried the way
 * titles are, except that the automatic list ends with the provider the chat is moving to (the
 * one the user chose) rather than the one it is leaving.
 */
export function createHandoffSummaryModel(
  deps: HandoffModelDeps,
  where: HandoffModelTarget,
): GenerateSummary {
  return async (call: SummaryCall) => {
    const { providers, pinned } = await resolvePimiModel({
      feature: "handoff",
      cwd: where.cwd,
      providerSnapshotManager: deps.providerSnapshotManager,
      daemonConfig: deps.daemonConfig(),
      currentSelection: where.target,
    });
    const usable = where.excludeProvider
      ? providers.filter((candidate) => candidate.provider !== where.excludeProvider)
      : providers;
    let used: { provider: string; model?: string } | null = null;
    const summary = await generateStructuredAgentResponseWithFallback({
      manager: deps.manager,
      cwd: where.cwd,
      prompt: call.prompt,
      schema: HandoffSummarySchema,
      schemaName: "HandoffSummary",
      providers: usable,
      pinned,
      feature: "handoff",
      maxRetries: 1,
      persistSession: false,
      turnTimeoutMs: Math.max(1_000, call.timeoutMs),
      logger: deps.logger,
      agentConfigOverrides: { title: "Chat handoff summary", internal: true, bare: true },
      runner: (options) => {
        used = { provider: options.agentConfig.provider, model: options.agentConfig.model };
        return generateStructuredAgentResponse(options);
      },
    });
    const model = used as { provider: string; model?: string } | null;
    return {
      summary: summary.summary,
      model: model ? (model.model ?? model.provider) : null,
    };
  };
}
