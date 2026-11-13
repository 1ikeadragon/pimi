import { getIsElectron } from "@/constants/platform";
import type { Agent } from "@/stores/session-store";
import type { WorkspaceDraftTabSetup } from "@/workspace-tabs/model";

export type ClientSlashCommandKind = "archive-agent" | "replace-agent-with-draft" | "open-browser";
export type ClientSlashCommandExecution = "immediate" | "insert";

export interface ClientSlashCommand {
  name: string;
  aliases: readonly string[];
  description: string;
  descriptionKey:
    | "composer.clientCommands.archiveAgent"
    | "composer.clientCommands.freshDraft"
    | "composer.clientCommands.openBrowser";
  argumentHint: string;
  kind: ClientSlashCommandKind;
  execution: ClientSlashCommandExecution;
  /** Text after the command is an argument; without this, `/clear foo` is sent as a message. */
  acceptsArgs: boolean;
  /** Offered in a draft tab, where no agent exists yet. */
  availableInDrafts: boolean;
  /** Exists only in the Electron desktop app. */
  desktopOnly: boolean;
  /** Runs without consuming the composer's pending attachments or draft. */
  keepsAttachments: boolean;
}

const CLIENT_SLASH_COMMANDS: readonly ClientSlashCommand[] = [
  {
    name: "exit",
    aliases: ["quit", "q"],
    description: "Archive the current agent",
    descriptionKey: "composer.clientCommands.archiveAgent",
    argumentHint: "",
    kind: "archive-agent",
    execution: "immediate",
    acceptsArgs: false,
    availableInDrafts: false,
    desktopOnly: false,
    keepsAttachments: false,
  },
  {
    name: "clear",
    aliases: ["new"],
    description: "Archive this agent and start a fresh draft",
    descriptionKey: "composer.clientCommands.freshDraft",
    argumentHint: "",
    kind: "replace-agent-with-draft",
    execution: "immediate",
    acceptsArgs: false,
    availableInDrafts: false,
    desktopOnly: false,
    keepsAttachments: false,
  },
  {
    name: "browser",
    aliases: ["web"],
    description: "Open a web page in the Pimi browser",
    descriptionKey: "composer.clientCommands.openBrowser",
    argumentHint: "[url]",
    kind: "open-browser",
    execution: "immediate",
    acceptsArgs: true,
    availableInDrafts: true,
    desktopOnly: true,
    keepsAttachments: true,
  },
];

/** The commands this runtime offers: desktop-only ones are absent on mobile and plain web. */
export function getClientSlashCommands(): readonly ClientSlashCommand[] {
  const isElectron = getIsElectron();
  return CLIENT_SLASH_COMMANDS.filter((command) => !command.desktopOnly || isElectron);
}

const SLASH_INPUT = /^\/([^\s]+)(?:\s+([\s\S]*))?$/;

export interface ResolvedClientSlashCommand {
  command: ClientSlashCommand;
  args: string;
}

export function resolveClientSlashCommand(input: {
  text: string;
  hasAttachments: boolean;
}): ResolvedClientSlashCommand | null {
  const match = SLASH_INPUT.exec(input.text.trim());
  if (!match) {
    return null;
  }
  const command = getClientSlashCommands().find(
    (candidate) => candidate.name === match[1] || candidate.aliases.includes(match[1]),
  );
  if (!command) {
    return null;
  }
  const args = (match[2] ?? "").trim();
  if (args && !command.acceptsArgs) {
    return null;
  }
  if (input.hasAttachments && !command.keepsAttachments) {
    return null;
  }
  return { command, args };
}

export function buildDraftAgentSetup(agent: Agent): WorkspaceDraftTabSetup {
  const featureValues: Record<string, unknown> = {};
  for (const feature of agent.features ?? []) {
    featureValues[feature.id] = feature.value;
  }

  return {
    provider: agent.provider,
    cwd: agent.cwd,
    modeId: agent.currentModeId ?? agent.runtimeInfo?.modeId ?? null,
    model: agent.model ?? agent.runtimeInfo?.model ?? null,
    thinkingOptionId: agent.thinkingOptionId ?? agent.runtimeInfo?.thinkingOptionId ?? null,
    featureValues,
  };
}
