import type { AgentProvider } from "./agent-types.js";

/**
 * Providers whose subagents the user can message. Claude Code has no API that addresses a running
 * or finished Task subagent directly; its only channel is the parent model's SendMessage tool, so
 * the daemon asks the parent session to deliver the message. Other providers' child sessions have
 * no such route wired yet.
 */
const MESSAGEABLE_PROVIDERS: ReadonlySet<string> = new Set(["claude"]);

export function canMessageProviderSubagent(provider: AgentProvider): boolean {
  return MESSAGEABLE_PROVIDERS.has(provider);
}
