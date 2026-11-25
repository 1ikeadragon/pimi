/**
 * Picks the rule table for a provider and runs it. Reads only paths the rule tables produce from
 * the working directory, the provider's home directories and the provider's own config; no
 * caller-supplied path is read.
 */
import { join } from "node:path";
import type {
  InstructionLayer,
  InstructionNotice,
  InstructionRuleset,
} from "@pimi/protocol/messages";
import { claudeConfigDir, claudeProjectDir } from "../providers/claude/project-dir.js";
import { resolveCodexHomeDir } from "../providers/codex-app-server-agent.js";
import { resolvePiAgentDir } from "../providers/pi/agent.js";
import type { InstructionFs } from "./fs.js";
import { createContext, findGitRoot } from "./layer.js";
import { INSTRUCTION_DISCOVERY_TIMEOUT_MS } from "./limits.js";
import { resolveClaudeLayers } from "./rules-claude.js";
import { resolveCodexLayers } from "./rules-codex.js";
import { resolveCopilotLayers } from "./rules-copilot.js";
import { resolveOpenCodeLayers } from "./rules-opencode.js";
import { resolvePiLayers } from "./rules-pi.js";

export interface ResolveProviderInstructionsInput {
  fs: InstructionFs;
  homeDir: string;
  platform: NodeJS.Platform;
  /** The built-in provider a custom provider extends, or the provider itself. */
  baseProvider: string;
  cwd: string;
  /** The environment the provider process launches with. */
  env: Readonly<Record<string, string | undefined>>;
  /** Which OpenCode runtime the chat uses; ignored for other providers. */
  openCode: { major: 1 | 2; externalServer: boolean } | null;
  /** The OpenCode mode the chat is in. */
  agentMode: string | null;
  now?: () => number;
}

export interface ProviderInstructions {
  ruleset: InstructionRuleset;
  layers: InstructionLayer[];
  truncated: boolean;
  notices: InstructionNotice[];
}

export async function resolveProviderInstructions(
  input: ResolveProviderInstructionsInput,
): Promise<ProviderInstructions> {
  const ruleset = rulesetFor(input);
  // Codex loads a file reached twice (a symlinked AGENTS.md) twice, so it keeps both rows.
  const ctx = createContext({
    fs: input.fs,
    homeDir: input.homeDir,
    platform: input.platform,
    env: input.env,
    cwd: input.cwd,
    dedupeTargets: ruleset !== "codex",
    timeoutMs: INSTRUCTION_DISCOVERY_TIMEOUT_MS,
    now: input.now,
  });
  const env = input.env as NodeJS.ProcessEnv;

  switch (ruleset) {
    case "claude": {
      const configDir = claudeConfigDir(env);
      // Claude keys auto memory by the repository root, not the working directory.
      const memoryRoot = (await findGitRoot(ctx, input.cwd)) ?? input.cwd;
      const autoMemoryDirectory = await claudeProjectDir(memoryRoot, { configDir });
      await resolveClaudeLayers(ctx, { configDir, autoMemoryDirectory });
      break;
    }
    case "codex":
      await resolveCodexLayers(ctx, { codexHome: resolveCodexHomeDir(env) });
      break;
    case "opencode_v1":
    case "opencode_v2": {
      const xdgConfig = env.XDG_CONFIG_HOME ?? join(input.homeDir, ".config");
      await resolveOpenCodeLayers(ctx, {
        major: ruleset === "opencode_v1" ? 1 : 2,
        configHome: join(xdgConfig, "opencode"),
        externalServer: input.openCode?.externalServer ?? false,
        agentName: input.agentMode,
      });
      break;
    }
    case "pi":
      await resolvePiLayers(ctx, {
        agentDirectory: resolvePiAgentDir(definedEntries(env)),
      });
      break;
    case "copilot":
      await resolveCopilotLayers(ctx, {
        copilotHome: env.COPILOT_HOME ?? join(input.homeDir, ".copilot"),
      });
      break;
    case "unknown":
      break;
  }
  return {
    ruleset,
    layers: ctx.state.layers,
    truncated: ctx.state.truncated,
    notices: ctx.state.notices,
  };
}

function rulesetFor(input: ResolveProviderInstructionsInput): InstructionRuleset {
  switch (input.baseProvider) {
    case "claude":
      return "claude";
    case "codex":
      return "codex";
    case "pi":
      return "pi";
    case "copilot":
      return "copilot";
    case "opencode":
      if (!input.openCode) return "unknown";
      return input.openCode.major === 1 ? "opencode_v1" : "opencode_v2";
    default:
      return "unknown";
  }
}

function definedEntries(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
