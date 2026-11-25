/**
 * The instructions Pimi adds to every interactive chat, as named parts. Launch joins them into
 * `daemonAppendSystemPrompt`; the Instructions view lists the same parts, so what the user reads
 * is what the agent got.
 */
import type { ProviderPimiToolsPolicy } from "@pimi/protocol/provider-config";
import type { AgentSessionConfig } from "../agent-sdk-types.js";
import { isPimiToolEnabled, isPimiToolPolicyEnabled } from "../pimi-tool-policy.js";
import { LAZY_TOOL_GROUP_NAMES } from "../tools/lazy-tool-groups.js";
import { CREW_LEAD_INSTRUCTIONS } from "../tools/crew-delegate.js";
import { memoryRecallInstructions } from "../tools/project-memory-tools.js";

// ---

/** Scopes Pimi's tools and keeps agents from opening a browser to check their own visuals. */
export const PIMI_SCOPE_INSTRUCTIONS =
  "Ordinary coding tasks need no Pimi tools. Show a visual by writing its block in the reply: Pimi draws it, so it needs no check. Never open a browser, take a screenshot, load browser tools, or start a server to check or show your own chart or page, unless the user asked for browser work.";

// Without its tools an agent asked to delegate or remember improvises: it runs `claude -p` or
// `codex exec` in a shell, or writes Pimi's memory files by hand. Neither shows up in Pimi.
/** The lead instructions for a chat in Crew mode that can reach the `delegate` tool. */
export function crewLeadInstructions(
  config: AgentSessionConfig,
  hostToolsEnabled: boolean,
  policy: ProviderPimiToolsPolicy | undefined,
): string[] {
  const delegates = config.crew && hostToolsEnabled && isPimiToolEnabled(policy, "delegate");
  return delegates ? [CREW_LEAD_INSTRUCTIONS] : [];
}

function pimiToolsOffInstructions(provider: string, hostToolsEnabled: boolean): string {
  const [where, fix] = hostToolsEnabled
    ? [
        `for this provider (${provider})`,
        `switch this chat to another provider, or remove "pimiTools": { "enabled": false } from agents.providers.${provider} in this host's Pimi config.json`,
      ]
    : [
        "on this host",
        "turn on Enable Pimi tools under Orchestration in this host's settings in Pimi",
      ];
  return `Pimi's agent tools are turned off ${where}, so you cannot start other agents or providers, use shared memory, or track tasks here. If the user asks for one of these, say that Pimi tools are off ${where} and that they can ${fix}. Do not run claude, codex, opencode, or another agent CLI from a shell instead, and do not write Pimi's memory or task files yourself.`;
}

// Only what an agent must know before it picks a tool lives here. How to use a tool is in that
// tool's description, which the agent reads once the tool is listed or loaded.
export function pimiActionInstructions(input: {
  policy: ProviderPimiToolsPolicy | undefined;
  provider: string;
  hostToolsEnabled: boolean;
}): string[] {
  const { policy } = input;
  if (!isPimiToolPolicyEnabled(policy)) {
    return [pimiToolsOffInstructions(input.provider, input.hostToolsEnabled)];
  }
  const instructions = [
    `Pimi lists only its core tools. For ${LAZY_TOOL_GROUP_NAMES.join(", ")}, call pimi_tools with a group, then run a tool with call_pimi_tool.`,
  ];
  if (isPimiToolEnabled(policy, "create_pimi_task")) {
    instructions.push(
      "When the user asks to add, track, or remember a task or to-do, call create_pimi_task.",
    );
  }
  if (isPimiToolEnabled(policy, "create_agent")) {
    instructions.push(
      'When the user asks for another agent, a worker, a second opinion, or another provider or model to do or answer something ("ask another agent", "use opencode to", "split this between two agents"), or for parallel workers, call create_agent once per worker, even on your own provider. Your built-in subagent tool (Task or Agent) and agent CLIs run from a shell (claude, codex, opencode, gemini) show the user nothing: never use them for a worker the user asked for or another model\'s answer, only for your own lookups.',
    );
  }
  if (isPimiToolEnabled(policy, "create_chat")) {
    instructions.push(
      'When the user asks to open or start a new chat, or to do something "in a new chat", call create_chat with initialPrompt: that chat is the user\'s own, not your worker.',
    );
  }
  if (isPimiToolEnabled(policy, "suggest_pimi_review")) {
    instructions.push(
      "When you finish changing files in a turn, call suggest_pimi_review with a one-line summary of what changed.",
    );
  }
  if (isPimiToolEnabled(policy, "browser_show")) {
    instructions.push(
      "When the user asks to see or open a web page or link, or you want them to look at one (for example a dev server you started), call browser_show with the URL and keep the link in your reply.",
    );
  }
  return instructions;
}

// ---

export type PimiInstructionPartId =
  | "scope"
  | "actions"
  | "visualization"
  | "crew_lead"
  | "memory"
  | "vault";

export interface PimiInstructionPart {
  part: PimiInstructionPartId;
  /** Each entry is one paragraph of the launch prompt. */
  texts: string[];
}

export interface PimiInstructionInputs {
  /** An interactive chat gets the scope, action, visualization and crew parts. */
  interactiveChat: boolean;
  config: AgentSessionConfig;
  hostToolsEnabled: boolean;
  policy: ProviderPimiToolsPolicy | undefined;
  /** The visualization text the chat gets, already chosen from the skill and guide-tool state. */
  visualizationInstructions: string;
  /** The chat may call the memory tools: not internal, not a history load, caller auth present. */
  canRecallMemory: boolean;
  /** The user's vault prompt lines; empty while the user has no vault. */
  vaultInstructions: string[];
}

/** The parts in launch order. A part with no text is left out. */
export function buildPimiInstructionParts(input: PimiInstructionInputs): PimiInstructionPart[] {
  const parts: PimiInstructionPart[] = [];
  if (input.interactiveChat) {
    parts.push(
      { part: "scope", texts: [PIMI_SCOPE_INSTRUCTIONS] },
      {
        part: "actions",
        texts: pimiActionInstructions({
          policy: input.policy,
          provider: input.config.provider,
          hostToolsEnabled: input.hostToolsEnabled,
        }),
      },
      { part: "visualization", texts: [input.visualizationInstructions] },
      {
        part: "crew_lead",
        texts: crewLeadInstructions(input.config, input.hostToolsEnabled, input.policy),
      },
    );
  }
  parts.push(
    { part: "memory", texts: input.canRecallMemory ? memoryRecallInstructions(input.policy) : [] },
    { part: "vault", texts: input.canRecallMemory ? input.vaultInstructions : [] },
  );
  return parts.filter((entry) => entry.texts.length > 0);
}

/** What launch hands a provider as `daemonAppendSystemPrompt`: the host prompt, then the parts. */
export function composeDaemonAppendPrompt(
  hostPrompt: string,
  parts: readonly PimiInstructionPart[],
): string {
  const additionalPrompt = parts.flatMap((entry) => entry.texts).join("\n\n");
  return [hostPrompt.trim(), additionalPrompt].filter(Boolean).join("\n\n");
}
