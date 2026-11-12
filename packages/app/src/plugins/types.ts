import type { PluginText } from "@pimi/plugin/client";
import type { PimiApi } from "@pimi/client";
import type { QueryClient } from "@tanstack/react-query";
import type { PluginRequirements } from "@pimi/protocol/messages";
import type {
  PluginAttachmentSourceContribution as SDKPluginAttachmentSourceContribution,
  PluginCleanup,
  PluginThemeContribution as SDKPluginThemeContribution,
} from "@pimi/plugin";
import type {
  PluginFilePanelContribution as SDKPluginFilePanelContribution,
  PluginCommandCenterItemContribution as SDKPluginCommandCenterItemContribution,
  PluginClientSlashCommandContribution as SDKPluginClientSlashCommandContribution,
  PluginComposerPillContribution as SDKPluginComposerPillContribution,
  PluginSidebarItemContribution as SDKPluginSidebarItemContribution,
  PluginScreenContribution as SDKPluginScreenContribution,
  PluginSettingsScreenContribution as SDKPluginSettingsScreenContribution,
  PluginTimelineRendererContribution,
  PluginTimelineTransformerContribution,
  PluginPanelLocation,
  PluginAgentPanelContribution as SDKPluginAgentPanelContribution,
  PluginWorkspacePanelContribution as SDKPluginWorkspacePanelContribution,
} from "@pimi/plugin/client";

type PluginFilePanelContribution = SDKPluginFilePanelContribution<PluginText>;
type PluginAttachmentSourceContribution = SDKPluginAttachmentSourceContribution<PluginText>;
type PluginThemeContribution = SDKPluginThemeContribution<PluginText>;
type PluginCommandCenterItemContribution = SDKPluginCommandCenterItemContribution<PluginText>;
type PluginClientSlashCommandContribution = SDKPluginClientSlashCommandContribution<PluginText>;
type PluginComposerPillContribution = SDKPluginComposerPillContribution<PluginText>;
type PluginSidebarItemContribution = SDKPluginSidebarItemContribution<PluginText>;
type PluginScreenContribution = SDKPluginScreenContribution<PluginText>;
type PluginSettingsScreenContribution = SDKPluginSettingsScreenContribution<PluginText>;
type PluginWorkspacePanelContribution =
  | (SDKPluginWorkspacePanelContribution<PluginText> & { context: "workspace" })
  | (SDKPluginAgentPanelContribution<PluginText> & { context: "agent" });

export type PluginSidebarSection = "header" | "footer";

export type EvaluatedPluginWorkspacePanelContribution = PluginWorkspacePanelContribution & {
  locations: readonly PluginPanelLocation[];
};

export interface EvaluatedPlugin {
  id: string;
  cleanup: PluginCleanup;
  surfaces: PluginScreenContribution[];
  settingsScreens: PluginSettingsScreenContribution[];
  sidebarItems: Record<PluginSidebarSection, PluginSidebarItemContribution[]>;
  filePanels: PluginFilePanelContribution[];
  workspacePanels: EvaluatedPluginWorkspacePanelContribution[];
  commandCenterItems: PluginCommandCenterItemContribution[];
  clientSlashCommands: PluginClientSlashCommandContribution[];
  attachmentSources: PluginAttachmentSourceContribution[];
  themes: PluginThemeContribution[];
  timelineTransformers: PluginTimelineTransformerContribution[];
  timelineRenderers: PluginTimelineRendererContribution[];
}

export interface InstalledPlugin extends EvaluatedPlugin {
  lifetime: AbortController;
  /** Immutable presentation locale, refreshed without replacing the installation lifetime. */
  locale: string;
  i18n: import("@pimi/plugin/client/host").PluginTranslationRuntime;
  /** The plugin's one Pimi client, `usePimi()` in every surface; disposed at teardown. */
  pimi: PimiApi;
  /** Calls one of the plugin's server RPC methods on its host. */
  invoke(method: string, input: unknown): Promise<unknown>;
  /** Subscribes to one of the plugin's server subscriptions; released with the lifetime. */
  subscribe: import("@pimi/plugin/client/host").PluginSubscribe;
  serverId: string;
  requirements?: PluginRequirements;
  clientBundle: string;
  queryClient: QueryClient;
}

export type {
  PluginFilePanelContribution,
  PluginAttachmentSourceContribution,
  PluginCommandCenterItemContribution,
  PluginClientSlashCommandContribution,
  PluginComposerPillContribution,
  PluginSidebarItemContribution,
  PluginScreenContribution,
  PluginSettingsScreenContribution,
  PluginThemeContribution,
  PluginTimelineRendererContribution,
  PluginTimelineTransformerContribution,
  PluginWorkspacePanelContribution,
};
