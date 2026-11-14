import type { AgentSessionConfig } from "../agent-sdk-types.js";

type Rule = "ask" | "allow" | "deny" | Record<string, "ask" | "allow" | "deny">;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Lets the provider read a chat's handoff transcript without a permission prompt. Claude takes it
 * as an additional directory. OpenCode treats it as an external directory and gets an allow rule
 * for it; a bare `allow`/`ask`/`deny` for all permissions is kept as the rule for everything
 * else. Codex needs nothing here: its sandbox policies restrict writes, not reads. Other
 * providers have no mechanism, so a read there goes through their normal permission flow.
 */
export function withTranscriptReadAccess(
  config: AgentSessionConfig,
  directory: string,
): AgentSessionConfig {
  const options = asRecord(config.providerOptions);
  if (config.provider === "claude") {
    const existing = Array.isArray(options.additionalDirectories)
      ? options.additionalDirectories.filter((entry): entry is string => typeof entry === "string")
      : [];
    if (existing.includes(directory)) return config;
    return {
      ...config,
      providerOptions: { ...options, additionalDirectories: [...existing, directory] },
    };
  }
  if (config.provider === "opencode") {
    const permission = options.permission;
    // One action for every permission cannot be split per directory; it stays as configured.
    if (typeof permission === "string") return config;
    const base = asRecord(permission);
    const current = base.external_directory as Rule | undefined;
    const rules: Record<string, string> =
      typeof current === "string"
        ? { "*": current }
        : ({ ...asRecord(current) } as Record<string, string>);
    rules[`${directory}/**`] = "allow";
    rules[directory] = "allow";
    return {
      ...config,
      providerOptions: { ...options, permission: { ...base, external_directory: rules } },
    };
  }
  return config;
}
