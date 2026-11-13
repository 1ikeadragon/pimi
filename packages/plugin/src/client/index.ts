export type {
  PluginHostProps,
  PluginTab,
  PluginPanelProps,
  PluginWorkspacePanelParams,
  PluginAgentPanelParams,
  PluginFilePanelParams,
  PluginAgentPanelContribution,
  PluginFilePanelContribution,
  PluginFilePanelProps,
  PluginSurfaceProps,
  PluginScreenProps,
  PluginPopoverProps,
  PluginScreenParams,
  PluginOpenScreenInput,
  PluginScreenLocation,
  PluginSidebarItemProps,
  PluginSidebarItemContribution,
  PluginIcon,
  PluginPanelLocation,
  PluginOpenPanelOptions,
  PluginWorkspacePanelProps,
  PluginAgentPanelProps,
  PluginClientOpenPanelOptions,
  PluginClientContext,
  PluginClientContribution,
  PluginWorkspacePanelContribution,
  PluginSettingsScreenContribution,
  PluginScreenContribution,
  PluginScreenTitle,
  PluginTimelineTransformerContribution,
  PluginTimelineItemProps,
  PluginTimelineRendererContribution,
  PluginCommandCapabilities,
  PluginGlobalCommandContext,
  PluginWorkspaceCommandContext,
  PluginAgentCommandContext,
  PluginCommandCenterItemContribution,
  PluginClientSlashCommandContribution,
  SettingsState,
} from "./contracts.js";
export type {
  PluginComponentPoints,
  PluginComponentPointId,
  PluginComponentOverrideProps,
  PluginComponentWrapperProps,
  PluginExtensionOptions,
  PluginMessageAttachment,
  PluginSlots,
  PluginSlotId,
  PluginSlotItem,
  PluginMenus,
  PluginMenuId,
  PluginMenuItemContribution,
} from "./extension-points.js";
export type {
  PluginActiveContext,
  PluginClientStorage,
  PluginGitCommits,
  PluginGitDiff,
  PluginGitDiffCompare,
  PluginGitStatus,
  PluginLayout,
  PluginNavigation,
  PluginProjectSnapshot,
  PluginQueryState,
  PluginTimelineEntry,
} from "./host-api.js";

export type {
  PluginButton,
  PluginButtonBehavior,
  PluginButtonContentProps,
  PluginButtonContext,
  PluginButtonIcon,
  PluginButtonIconProps,
  PluginButtonMenuEntry,
  PluginButtonRegistration,
  PluginComposerPillContribution,
  PluginHeaderButtonContribution,
} from "./buttons.js";
export type { PluginIconProps, PluginSerializableIcon, PluginSvgIcon } from "../icons.js";
export type {
  PluginFile,
  PluginFileBytesState,
  PluginFileEvent,
  PluginFileTextState,
  PluginFileUrlState,
  PluginFileWriteOptions,
} from "./file.js";
export {
  PluginFileConflictError,
  PluginFileDeletedError,
  useFileBytes,
  useFileText,
  useFileUrl,
} from "./file.js";
export type { PimiApi } from "@pimi/client";

/** Workspaces of one host, or of the plugin's own host when `serverId` is omitted. */
export declare function useWorkspaces(serverId?: string): readonly PluginWorkspaceSnapshot[];
/** Agents of one host, optionally limited to one workspace. */
export declare function useAgents(options?: {
  serverId?: string;
  workspaceId?: string;
}): readonly PluginAgentSnapshot[];
export declare function useProjects(serverId?: string): readonly PluginProjectSnapshot[];
export declare function useActiveContext(): PluginActiveContext;
/** The newest `tail` rows (default 50) of an agent's chat. Read-only. */
export declare function useAgentTimeline(
  agentId: string,
  options?: { serverId?: string; tail?: number },
): readonly PluginTimelineEntry[];
export declare function useCheckoutStatus(
  cwd: string | null,
  options?: { serverId?: string },
): PluginQueryState<PluginGitStatus>;
export declare function useCheckoutDiff(
  cwd: string | null,
  compare: PluginGitDiffCompare,
  options?: { serverId?: string },
): PluginQueryState<PluginGitDiff>;
export declare function useCommits(
  cwd: string | null,
  options?: { serverId?: string },
): PluginQueryState<PluginGitCommits>;
/** The active theme: every semantic color, spacing, radius, font size and family. */
export declare function useTheme(): PluginTheme;
export declare function useLayout(): PluginLayout;
export declare function useNavigation(): PluginNavigation;
export declare function useClientStorage(): PluginClientStorage;

export { usePimi } from "./pimi-context.js";
export { useAgent, useWorkspace } from "./client-state.js";
export { useRpc, useSubscription, type PluginSubscriptionState } from "./rpc-context.js";
export type {
  PluginSubscribeOptions,
  PluginSubscriptionClosed,
  PluginSubscriptionHandle,
} from "../rpc.js";
import type { SettingsDefinition } from "../settings.js";
import type { PluginAgentSnapshot, PluginTheme, PluginWorkspaceSnapshot } from "../contracts.js";
import type {
  PluginActiveContext,
  PluginClientStorage,
  PluginGitCommits,
  PluginGitDiff,
  PluginGitDiffCompare,
  PluginGitStatus,
  PluginLayout,
  PluginNavigation,
  PluginProjectSnapshot,
  PluginQueryState,
  PluginTimelineEntry,
} from "./host-api.js";
import type { SettingsState } from "./contracts.js";
import type { ZodType } from "zod";
export declare function useSettings<Schema extends ZodType>(
  definition: SettingsDefinition<Schema>,
): SettingsState<Schema>;

/** Configured app host, including hosts that are currently disconnected. */
export interface PluginHostSummary {
  readonly serverId: string;
  readonly label: string;
  readonly status: "idle" | "connecting" | "online" | "offline" | "error";
}
/** Live configured hosts. Supplied by the app's client bundle loader. */
export declare function useHosts(): readonly PluginHostSummary[];
/** Borrow an online host's API under this installation's lifetime. */
export declare function getPimiClient(serverId: string): import("@pimi/client").PimiApi;
/** Open an absolute HTTP(S) URL using the client platform’s external opener. */
export declare function openExternalUrl(url: string): Promise<void>;

export { defineTranslations, useTranslation } from "./translations.js";
export type { PluginI18n } from "./translations.js";
export type { PluginText, PluginMessage, PluginTranslations } from "../text.js";

export { useTabState } from "./tab.js";
export { isComposerChipChar } from "./composer.js";
export type {
  PluginAddAttachmentOptions,
  PluginAnnotationAttachment,
  PluginAnnotationAttachmentInput,
  PluginAnnotationAttachmentPatch,
  PluginAnnotationSource,
  PluginAttachmentRendererContribution,
  PluginAttachmentRendererProps,
  PluginComposer,
  PluginComposerApi,
  PluginComposerAttachment,
  PluginComposerAttachmentInput,
  PluginComposerAttachmentKind,
  PluginComposerAttachments,
  PluginComposerKeyEvent,
  PluginComposerSelection,
} from "./composer.js";
