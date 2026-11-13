import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  useAutocompleteCommands,
  type AgentSlashCommand,
  type DraftCommandTarget,
} from "@/agent-commands";
import { getClientSlashCommands, type ClientSlashCommand } from "@/client-slash-commands";
import { resolveDraftQueryConfig } from "@/hooks/use-agent-autocomplete";
import type { ComposerEditingSession } from "@/composer/editing-session";
import { useComposerKeyboardScope } from "@/composer/keyboard-scope";
import type { CommandCenterContribution } from "./contributions";
import { useCommandCenterActions } from "./provider";

/** Provider commands first, then the app's own, each group in the order its source lists them. */
const PROVIDER_GROUP_RANK = 0;
const CLIENT_GROUP_RANK = 1;

export function buildSlashContributions(source: {
  providerCommands: readonly AgentSlashCommand[];
  clientCommands: readonly ClientSlashCommand[];
  describeClient(command: ClientSlashCommand): string;
  insert(token: string): void;
  /** Runs a client command that executes at once; false when it can only be inserted. */
  runClient(command: ClientSlashCommand): boolean;
}): CommandCenterContribution[] {
  const provider = source.providerCommands.map<CommandCenterContribution>((command, rank) => ({
    id: `provider:${command.name}`,
    category: "slash",
    group: "slash-provider",
    groupRank: PROVIDER_GROUP_RANK,
    rank,
    keywords: [],
    visibility: "always",
    run: () => source.insert(`/${command.name}`),
    presentation: {
      kind: "action",
      title: `/${command.name}`,
      subtitle: command.description,
    },
  }));
  const client = source.clientCommands.map<CommandCenterContribution>((command, rank) => ({
    id: `client:${command.name}`,
    category: "slash",
    group: "slash-client",
    groupRank: CLIENT_GROUP_RANK,
    rank,
    keywords: command.aliases,
    visibility: "always",
    run: () => {
      if (!source.runClient(command)) source.insert(`/${command.name}`);
    },
    presentation: {
      kind: "action",
      title: `/${command.name}`,
      subtitle: source.describeClient(command),
    },
  }));
  return [...provider, ...client];
}

/**
 * Registers the focused composer's slash commands with the palette's `/` mode. Mount it inside
 * the composer: it listens only while that composer is the active one, so the list is always the
 * agent you are typing to.
 */
export function SlashCommandCenterActions({
  serverId,
  agentId,
  draft,
  editingSession,
  runClient,
}: {
  serverId: string;
  agentId: string;
  /** Set in a draft composer, whose agentId is a draft key the daemon does not know. */
  draft?: DraftCommandTarget;
  editingSession: ComposerEditingSession;
  runClient(command: ClientSlashCommand): boolean;
}) {
  const { isActiveComposer } = useComposerKeyboardScope();
  const { t } = useTranslation();
  // A draft lists commands by its config alone, and not until that config is complete.
  const draftConfig = resolveDraftQueryConfig(draft);
  const canListCommands = draft === undefined || draftConfig !== undefined;
  const { commands } = useAutocompleteCommands({
    serverId,
    agentId,
    enabled: isActiveComposer && canListCommands,
    draftConfig,
  });
  const actions = useMemo(
    () =>
      buildSlashContributions({
        providerCommands: commands,
        clientCommands: getClientSlashCommands(),
        describeClient: (command) => t(command.descriptionKey),
        insert: (token) => editingSession.insertCommand(token),
        runClient,
      }),
    [commands, editingSession, runClient, t],
  );
  useCommandCenterActions({ sourceId: "slash", enabled: isActiveComposer, actions });
  return null;
}
