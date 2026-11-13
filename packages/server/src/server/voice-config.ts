import { renderTemplate } from "./prompts/render.js";

const VOICE_PROMPT_BLOCK_START = "<pimi_voice_mode>";
const VOICE_PROMPT_BLOCK_END = "</pimi_voice_mode>";

const VOICE_AGENT_SYSTEM_INSTRUCTION = renderTemplate("voice-mode-on", {});

const VOICE_AGENT_DISABLED_INSTRUCTION = renderTemplate("voice-mode-off", {});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeVoicePromptBlockRegex(): RegExp {
  return new RegExp(
    `${escapeRegExp(VOICE_PROMPT_BLOCK_START)}[\\s\\S]*?${escapeRegExp(VOICE_PROMPT_BLOCK_END)}`,
    "g",
  );
}

export function stripVoiceModeSystemPrompt(existing?: string): string | undefined {
  const trimmed = existing?.trim();
  if (!trimmed) {
    return undefined;
  }
  const stripped = trimmed.replace(makeVoicePromptBlockRegex(), "").trim();
  return stripped.length > 0 ? stripped : undefined;
}

export function buildVoiceModeSystemPrompt(existing: string | undefined, enabled: boolean): string {
  const basePrompt = stripVoiceModeSystemPrompt(existing);
  const voiceInstruction = enabled
    ? VOICE_AGENT_SYSTEM_INSTRUCTION
    : VOICE_AGENT_DISABLED_INSTRUCTION;
  const voiceBlock = [VOICE_PROMPT_BLOCK_START, voiceInstruction, VOICE_PROMPT_BLOCK_END].join(
    "\n",
  );

  return [basePrompt, voiceBlock]
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .join("\n\n");
}

export function wrapSpokenInput(text: string): string {
  return renderTemplate("voice-spoken-input", { text });
}

export function buildVoiceAgentMcpServerConfig(params: {
  command: string;
  baseArgs: string[];
  socketPath: string;
  env?: Record<string, string>;
}): {
  type: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
} {
  return {
    type: "stdio",
    command: params.command,
    args: [...params.baseArgs, "--socket", params.socketPath],
    ...(params.env ? { env: params.env } : {}),
  };
}
