import { useMemo } from "react";
import type { SavedPrompt } from "@pimi/protocol/prompt/types";
import { usePrompts } from "./use-prompts";

/** A saved prompt as a slash command: its text replaces the name when picked or sent. */
export interface PromptSlashCommand {
  name: string;
  description: string;
  text: string;
  // Text after the name is appended to the prompt, so there is nothing to hint.
  argumentHint?: undefined;
}

const NO_COMMANDS: readonly PromptSlashCommand[] = [];

// The menu row shows what the prompt starts with; the user's own text, so it is never translated.
function firstLine(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim().length > 0);
  return line?.trim() ?? "";
}

function isVisibleInProject(prompt: SavedPrompt, projectId: string | null): boolean {
  return prompt.projectId === null || prompt.projectId === projectId;
}

function toSlashCommands(
  prompts: readonly SavedPrompt[] | undefined,
  projectId: string | null,
): readonly PromptSlashCommand[] {
  if (!prompts) return NO_COMMANDS;
  return prompts
    .filter((prompt) => isVisibleInProject(prompt, projectId))
    .map((prompt) => ({
      name: prompt.name,
      description: firstLine(prompt.text),
      text: prompt.text,
    }));
}

/** The host's saved prompts that apply to `projectId`, as slash commands. */
export function usePromptSlashCommands(
  serverId: string,
  projectId: string | null,
  options: { enabled?: boolean } = {},
): readonly PromptSlashCommand[] {
  const prompts = usePrompts(serverId, options);
  return useMemo(() => toSlashCommands(prompts.data, projectId), [prompts.data, projectId]);
}

/**
 * `/name rest` for a saved prompt becomes its text, then a blank line and `rest`. Null when the
 * text is not a saved prompt, so the caller sends it as typed.
 */
export function expandPromptSlashCommand(input: {
  text: string;
  commands: readonly PromptSlashCommand[];
}): string | null {
  if (input.commands.length === 0) return null;
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(input.text.trim());
  if (!match) return null;
  const command = input.commands.find((candidate) => candidate.name === match[1]);
  if (!command) return null;
  const rest = (match[2] ?? "").trim();
  return rest ? `${command.text}\n\n${rest}` : command.text;
}
