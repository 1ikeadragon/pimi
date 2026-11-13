import type { AnyComponent } from "@/extension-points/registry";
import type { PluginText } from "@pimi/plugin/client";
import type { PimiApi } from "@pimi/client";
import type {
  PluginClientStorage,
  PluginMenuId,
  PluginMenuItemContribution as SDKPluginMenuItemContribution,
  PluginNavigation,
} from "@pimi/plugin/client";
import type { createPluginHosts } from "./hosts";
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
  PluginAttachmentRendererContribution,
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

export type PluginMenuItemContribution = {
  [Id in PluginMenuId]: SDKPluginMenuItemContribution<Id, string>;
}[PluginMenuId];

/** A component layer a plugin registered; applied to the extension registry by the app. */
export interface PluginComponentLayerRegistration {
  kind: "replacement" | "wrapper";
  point: string;
  tier: "typed" | "unstable";
  order: number;
  Component: AnyComponent;
}

export interface PluginSlotRegistration {
  slot: string;
  id: string;
  order: number;
  Component: AnyComponent;
}

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
  attachmentRenderers: PluginAttachmentRendererContribution[];
  themes: PluginThemeContribution[];
  timelineTransformers: PluginTimelineTransformerContribution[];
  timelineRenderers: PluginTimelineRendererContribution[];
  componentLayers: PluginComponentLayerRegistration[];
  slotItems: PluginSlotRegistration[];
  menuItems: PluginMenuItemContribution[];
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
  /** What `useNavigation()` and `client.navigation` call. */
  navigation: PluginNavigation;
  storage: PluginClientStorage;
  /** The installation's host connections, for `getPimiClient` and cross-host hooks. */
  hosts: ReturnType<typeof createPluginHosts>;
}

export type {
  PluginFilePanelContribution,
  PluginAttachmentSourceContribution,
  PluginAttachmentRendererContribution,
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
