import type { AgentProvider } from "./agent-types.js";

/**
 * Providers whose subagents the user can message. Codex child threads and OpenCode child sessions
 * take a prompt of their own. Claude Code has no API that addresses a Task subagent; its only
 * channel is the parent model's SendMessage tool, so the daemon asks the parent session to relay
 * the text. Other providers' children have no route wired.
 */
const MESSAGEABLE_PROVIDERS: ReadonlySet<string> = new Set(["claude", "codex", "opencode"]);

export function canMessageProviderSubagent(provider: AgentProvider): boolean {
  return MESSAGEABLE_PROVIDERS.has(provider);
}
