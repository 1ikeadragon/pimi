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

/**
 * `/name args` for a saved flow becomes the prompt that makes the agent call `run_flow`. Returns
 * null when the text is not a flow command, so the caller sends it as typed.
 */
export function resolveFlowSlashPrompt(input: {
  text: string;
  hasAttachments: boolean;
  commands: readonly FlowSlashCommand[];
  t: TFunction;
}): string | null {
  if (input.hasAttachments || input.commands.length === 0) return null;
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(input.text.trim());
  if (!match) return null;
  const name = match[1];
  if (!input.commands.some((command) => command.name === name)) return null;
  const args = (match[2] ?? "").trim();
  return args
    ? input.t("flows.runPrompt", { name, input: args })
    : input.t("flows.runPromptNoInput", { name });
}
