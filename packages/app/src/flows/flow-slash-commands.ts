import { useMemo } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import type { Flow } from "@pimi/protocol/flow/types";
import { flowsQueryKey, useFlows } from "./use-flows";

/** A saved flow as a slash command. */
export interface FlowSlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
}

const NO_COMMANDS: readonly FlowSlashCommand[] = [];

export function flowToSlashCommand(flow: Flow): FlowSlashCommand {
  return {
    name: flow.name,
    description: flow.description,
    ...(flow.argumentHint ? { argumentHint: flow.argumentHint } : {}),
  };
}

/** The host's flows as slash commands, from the cached flow list. */
export function useFlowSlashCommands(
  serverId: string,
  options: { enabled?: boolean } = {},
): readonly FlowSlashCommand[] {
  const flows = useFlows(serverId, options);
  return useMemo(
    () => (flows.data ? flows.data.map(flowToSlashCommand) : NO_COMMANDS),
    [flows.data],
  );
}

/** The flows the slash menu already fetched; sending never starts a fetch of its own. */
export function readCachedFlowSlashCommands(
  queryClient: QueryClient,
  serverId: string,
): readonly FlowSlashCommand[] {
  const flows = queryClient.getQueryData<Flow[]>(flowsQueryKey(serverId));
  return flows ? flows.map(flowToSlashCommand) : NO_COMMANDS;
}

/** `/name args` for a saved flow: its name and the text after it. Null when it is not one. */
export function parseFlowSlashCommand(input: {
  text: string;
  hasAttachments: boolean;
  commands: readonly FlowSlashCommand[];
}): { name: string; input: string } | null {
  if (input.hasAttachments || input.commands.length === 0) return null;
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(input.text.trim());
  if (!match) return null;
  const name = match[1];
  if (!input.commands.some((command) => command.name === name)) return null;
  return { name, input: (match[2] ?? "").trim() };
}

/**
 * The prompt that makes an agent call `run_flow`, for a chat that does not exist yet and so has
 * nowhere to put a run card. Returns null when the text is not a flow command.
 */
export function resolveFlowSlashPrompt(input: {
  text: string;
  hasAttachments: boolean;
  commands: readonly FlowSlashCommand[];
  t: TFunction;
}): string | null {
  const parsed = parseFlowSlashCommand(input);
  if (!parsed) return null;
  return parsed.input
    ? input.t("flows.runPrompt", { name: parsed.name, input: parsed.input })
    : input.t("flows.runPromptNoInput", { name: parsed.name });
}
