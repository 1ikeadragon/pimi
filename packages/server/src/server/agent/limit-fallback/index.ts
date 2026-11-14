import type { Logger } from "pino";
import type { MutableDaemonConfig } from "../../daemon-config-store.js";
import type { AgentManager, ManagedAgent } from "../agent-manager.js";
import { sendPreparedPromptToAgent } from "../agent-prompt.js";
import type { AgentStorage } from "../agent-storage.js";
import type { AgentTurnLimit } from "../agent-sdk-types.js";
import {
  AgentProviderSwitchError,
  resolveAgentProviderSwitchTarget,
  type AgentProviderSwitchTarget,
} from "../provider-switch.js";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import { resolveCarriedPermissionMode, type CarriedMode } from "./permission-mode.js";

const CONTINUATION_PROMPT =
  "The previous provider hit its usage limit. Continue the last request from where it stopped.";

interface LimitFallbackDeps {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  providerSnapshotManager: ProviderSnapshotManager;
  config(): MutableDaemonConfig["limitFallback"];
  logger: Logger;
}

/** Per chat, for the user prompt being worked on. */
interface PromptState {
  /** provider + model pairs that already failed or were skipped for this prompt. */
  tried: Set<string>;
  /** The next turn start is our own continuation, not the user's. */
  continuationPending: boolean;
}

function endpointKey(provider: string, model: string | null | undefined): string {
  return `${provider}\u0000${model ?? ""}`;
}

/**
 * Moves a chat to the next provider in the host's chain when its provider reports a limit.
 *
 * The only trigger is a structured `limit` on `turn_failed`, set by the provider adapter. Error
 * text is never read. Each chain entry is tried at most once per user prompt, so a chain of up to
 * five entries cannot loop; a human prompt (a turn this module did not start) or a finished turn
 * starts the count again.
 */
export function createLimitFallback(deps: LimitFallbackDeps): { dispose(): void } {
  const { agentManager, agentStorage, providerSnapshotManager, logger } = deps;
  const states = new Map<string, PromptState>();
  // Providers that said when they recover. Entries without a reset time are skipped for the
  // current prompt only, through `tried`, rather than guessed at.
  const limitedUntil = new Map<string, number>();
  const handling = new Set<string>();

  const stateFor = (agentId: string): PromptState => {
    let state = states.get(agentId);
    if (!state) {
      state = { tried: new Set(), continuationPending: false };
      states.set(agentId, state);
    }
    return state;
  };

  async function isEnabledFor(agent: ManagedAgent): Promise<boolean> {
    const config = deps.config();
    if (!config.enabled || config.chain.length === 0) return false;
    if (agent.internal || agent.background) return false;
    const record = await agentStorage.get(agent.id);
    return !record?.limitFallbackDisabled && !record?.archivedAt;
  }

  /** The first chain entry that is usable now and not yet tried for this prompt. */
  async function pickTarget(
    agent: ManagedAgent,
    state: PromptState,
  ): Promise<AgentProviderSwitchTarget | null> {
    for (const entry of deps.config().chain) {
      let target: AgentProviderSwitchTarget;
      try {
        target = await resolveAgentProviderSwitchTarget({
          providerSnapshotManager,
          provider: entry.provider,
          model: entry.model,
          cwd: agent.cwd,
        });
      } catch (error) {
        if (!(error instanceof AgentProviderSwitchError)) throw error;
        logger.info(
          { agentId: agent.id, provider: entry.provider, model: entry.model, code: error.code },
          "limit_fallback.entry_skipped",
        );
        state.tried.add(endpointKey(entry.provider, entry.model));
        continue;
      }
      const key = endpointKey(target.provider, target.model);
      const until = limitedUntil.get(key);
      if (state.tried.has(key) || (until !== undefined && until > Date.now())) continue;
      state.tried.add(key);
      return target;
    }
    return null;
  }

  async function handleLimit(agent: ManagedAgent, limit: AgentTurnLimit): Promise<void> {
    if (!(await isEnabledFor(agent))) return;
    const state = stateFor(agent.id);
    const current = endpointKey(agent.provider, agent.runtimeInfo?.model ?? agent.config.model);
    state.tried.add(current);
    const resetsAtMs = limit.resetsAt ? Date.parse(limit.resetsAt) : Number.NaN;
    if (Number.isFinite(resetsAtMs)) limitedUntil.set(current, resetsAtMs);

    const source = await describeSource(agent);
    for (
      let target = await pickTarget(agent, state);
      target;
      target = await pickTarget(agent, state)
    ) {
      // A model change inside one provider keeps the session, and with it the mode.
      const carried: CarriedMode =
        target.provider === agent.provider
          ? { modeId: target.modeId, featureValues: target.featureValues }
          : await resolveCarriedPermissionMode({
              providerSnapshotManager,
              agent,
              targetProvider: target.provider,
              target,
            });
      try {
        await agentManager.switchAgentProvider(
          agent.id,
          { ...target, modeId: carried.modeId, featureValues: carried.featureValues },
          {
            source,
            limit: {
              reason: "limit",
              ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}),
              ...(carried.permissionMode ? { permissionMode: carried.permissionMode } : {}),
            },
          },
        );
      } catch (error) {
        // The manager rolled the chat back to its old session; try the next entry.
        logger.warn(
          { err: error, agentId: agent.id, provider: target.provider, model: target.model },
          "limit_fallback.switch_failed",
        );
        continue;
      }
      logger.info(
        {
          agentId: agent.id,
          from: agent.provider,
          to: target.provider,
          model: target.model,
          kind: limit.kind,
          permissionModeCarried: carried.permissionMode?.carried,
        },
        "limit_fallback.switched",
      );
      await continueRequest(agent.id, state);
      return;
    }

    logger.info({ agentId: agent.id, kind: limit.kind }, "limit_fallback.exhausted");
    await agentManager.appendTimelineItem(agent.id, {
      type: "notification",
      level: "info",
      message: "No fallback available: every provider in the On limit list was tried or is limited",
    });
  }

  async function continueRequest(agentId: string, state: PromptState): Promise<void> {
    state.continuationPending = true;
    try {
      await sendPreparedPromptToAgent({
        agentId,
        prompt: CONTINUATION_PROMPT,
        agentManager,
        agentStorage,
        logger,
        unarchive: false,
      });
    } catch (error) {
      state.continuationPending = false;
      logger.error({ err: error, agentId }, "limit_fallback.continuation_failed");
    }
  }

  async function describeSource(agent: ManagedAgent) {
    const model = agent.runtimeInfo?.model ?? agent.config.model;
    const entry = await providerSnapshotManager
      .getProvider({ provider: agent.provider, cwd: agent.cwd, wait: false })
      .catch(() => null);
    return {
      provider: agent.provider,
      providerLabel: entry?.label ?? providerSnapshotManager.getProviderLabel(agent.provider),
      modelLabel: entry?.models?.find((candidate) => candidate.id === model)?.label,
    };
  }

  const unsubscribe = agentManager.subscribe(
    (event) => {
      if (event.type !== "agent_stream") return;
      const { agentId } = event;
      switch (event.event.type) {
        case "turn_started": {
          const state = states.get(agentId);
          if (!state) return;
          // Our own continuation keeps the count; any other turn is a new user prompt.
          if (state.continuationPending) state.continuationPending = false;
          else states.delete(agentId);
          return;
        }
        case "turn_completed":
        case "turn_canceled":
          states.delete(agentId);
          return;
        case "turn_failed": {
          const { limit } = event.event;
          if (!limit) {
            states.delete(agentId);
            return;
          }
          if (handling.has(agentId)) return;
          const agent = agentManager.getAgent(agentId);
          if (!agent) return;
          handling.add(agentId);
          void handleLimit(agent, limit)
            .catch((error) => logger.error({ err: error, agentId }, "limit_fallback.failed"))
            .finally(() => handling.delete(agentId));
          return;
        }
        default:
          return;
      }
    },
    { replayState: false },
  );

  return {
    dispose() {
      unsubscribe();
      states.clear();
    },
  };
}
