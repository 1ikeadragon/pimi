import type { TerminalHooksStatus } from "@pimi/protocol/messages";
import {
  type AgentHookActivityInput,
  type AgentHookActivityState,
  type AgentHookInstallLogger,
  type AgentHookInstallOptions,
  type AgentHookInstallResult,
  type AgentHookProvider,
  agentHooksAreInstalled,
  getAgentHookInstallState,
  installAgentHooks,
  uninstallAgentHooks,
} from "./agent-hook-installer.js";
import { claudeAgentHookProvider } from "./claude/claude.js";
import { codexAgentHookProvider } from "./codex/codex.js";
import { opencodeAgentHookProvider } from "./opencode/opencode.js";

export type {
  AgentHookActivityInput,
  AgentHookActivityState,
  AgentHookProvider,
} from "./agent-hook-installer.js";

export const AGENT_HOOK_PROVIDERS = {
  claude: claudeAgentHookProvider,
  codex: codexAgentHookProvider,
  opencode: opencodeAgentHookProvider,
} satisfies Record<string, AgentHookProvider>;

export type AgentHookProviderId = keyof typeof AGENT_HOOK_PROVIDERS;
const providerIds = Object.keys(AGENT_HOOK_PROVIDERS) as AgentHookProviderId[];

export function getRegisteredAgentHookStatus(
  options: AgentHookInstallOptions = {},
): TerminalHooksStatus["providers"] {
  return providerIds.map((provider) => {
    try {
      return { provider, state: getAgentHookInstallState(AGENT_HOOK_PROVIDERS[provider], options) };
    } catch {
      // An unreadable, malformed, or foreign config must not look absent. Never send file contents
      // or paths back to remote clients.
      return { provider, state: "unavailable" };
    }
  });
}

export interface AgentHookActivityRequest {
  provider: string;
  event: string;
  input: AgentHookActivityInput;
}

export interface RegisteredAgentHookInstallOptions extends AgentHookInstallOptions {
  logger?: AgentHookInstallLogger;
}

export function installRegisteredAgentHooks(
  options: RegisteredAgentHookInstallOptions = {},
): AgentHookInstallResult[] {
  const results: AgentHookInstallResult[] = [];
  for (const provider of Object.values(AGENT_HOOK_PROVIDERS)) {
    try {
      results.push(installAgentHooks(provider, options));
    } catch (error) {
      options.logger?.warn(
        { err: error, provider: provider.id },
        "Failed to install terminal activity hook provider",
      );
    }
  }
  return results;
}

export function uninstallRegisteredAgentHooks(
  options: RegisteredAgentHookInstallOptions = {},
): void {
  const errors: unknown[] = [];
  for (const provider of Object.values(AGENT_HOOK_PROVIDERS)) {
    try {
      uninstallAgentHooks(provider, options);
    } catch (error) {
      if (options.logger) {
        options.logger.warn(
          { err: error, provider: provider.id },
          "Failed to remove terminal activity hook provider",
        );
      } else {
        errors.push(error);
      }
    }
  }
  if (errors.length) throw new AggregateError(errors, "Failed to remove terminal activity hooks");
}

export function registeredAgentHooksAreInstalled(options: AgentHookInstallOptions = {}): boolean {
  return Object.values(AGENT_HOOK_PROVIDERS).every((provider) =>
    agentHooksAreInstalled(provider, options),
  );
}

export async function resolveHookActivity(
  request: AgentHookActivityRequest,
): Promise<AgentHookActivityState | null> {
  const id = request.provider.toLowerCase();
  if (!Object.hasOwn(AGENT_HOOK_PROVIDERS, id)) return null;
  const provider = AGENT_HOOK_PROVIDERS[id as AgentHookProviderId];

  return provider.resolveActivity({ event: request.event, input: request.input });
}
