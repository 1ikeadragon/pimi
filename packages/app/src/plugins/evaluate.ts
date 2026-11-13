import type { AnyComponent } from "@/extension-points/registry";
import { requirePluginText } from "@pimi/plugin/client/host";
import type { createPluginHosts } from "./hosts";
import { openExternalUrl } from "@/utils/open-external-url";
import * as pluginUiRuntime from "./react-native/ui";
import { useSettings } from "./settings/use-settings";
import * as pluginSharedRuntime from "@pimi/plugin";
import * as pluginClientRuntime from "@pimi/plugin/client";
import * as React from "react";
import * as ReactJsxRuntime from "react/jsx-runtime";
import * as ReactNativeGestureHandler from "react-native-gesture-handler";
import * as ReactNativeReanimated from "react-native-reanimated";
import * as ReactNativeSafeAreaContext from "react-native-safe-area-context";
import * as ReactNativeSvg from "react-native-svg";
import type { PluginClientHostModule } from "@pimi/protocol/plugin-host-modules";
import * as hostApi from "./host-api";
// eslint-disable-next-line no-restricted-imports -- plugin client runtime injects host ReactNative.
import * as ReactNative from "react-native";
// eslint-disable-next-line no-restricted-imports -- plugin bundles receive TanStack's real runtime, not Pimi's query wrappers.
import * as ReactQuery from "@tanstack/react-query";
import * as Zod from "zod";
import { type PluginCleanup } from "@pimi/plugin";
import {
  type PluginClientContext,
  type PluginAgentPanelContribution,
  type PluginWorkspacePanelContribution as WorkspacePanelInput,
  type PluginScreenTitle,
  type PluginText,
  type PluginTimelineRendererContribution,
  type PluginTimelineTransformerContribution,
  type PluginButtonRegistration,
  type PluginMenuId,
} from "@pimi/plugin/client";
import type {
  EvaluatedPlugin,
  PluginSidebarSection,
  PluginAttachmentSourceContribution,
  PluginAttachmentRendererContribution,
  PluginThemeContribution,
  PluginCommandCenterItemContribution,
  PluginClientSlashCommandContribution,
  PluginScreenContribution,
  PluginSidebarItemContribution,
  PluginWorkspacePanelContribution,
  PluginMenuItemContribution,
} from "./types";
import { parsePluginIcon, parseSerializablePluginIcon } from "./icons";
import { parsePluginThemeContribution } from "./themes";

const CONTRIBUTION_ID = /^[a-z][a-z0-9-]*$/;
const PANEL_LOCATIONS = ["workspace", "explorer"] as const;
const ATTACHMENT_RENDERER_KINDS = new Set<string>(["annotation"]);
const TIMELINE_ITEM_TYPES = new Set([
  "user_message",
  "assistant_message",
  "reasoning",
  "tool_call",
  "todo",
  "notification",
  "error",
  "compaction",
]);

function normalizePanelLocations(
  panelId: string,
  locations: PluginWorkspacePanelContribution["locations"],
): readonly (typeof PANEL_LOCATIONS)[number][] {
  if (locations === undefined) return ["workspace"];
  if (!Array.isArray(locations) || locations.length === 0) {
    throw new Error(`Workspace panel ${panelId} must support at least one location`);
  }
  const normalized = locations.map((location) => {
    if (!PANEL_LOCATIONS.includes(location as never)) {
      throw new Error(`Workspace panel ${panelId} has invalid location: ${String(location)}`);
    }
    return location;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`Workspace panel ${panelId} has duplicate locations`);
  }
  return normalized;
}

function isComponentType(value: unknown): boolean {
  return (
    typeof value === "function" ||
    (typeof value === "object" && value !== null && "$$typeof" in value)
  );
}

function normalizePluginText(text: import("@pimi/plugin/client").PluginText) {
  return typeof text === "string" ? text.trim() : requirePluginText(text);
}

function requireId(value: string, label: string): string {
  const id = value.trim();
  if (!CONTRIBUTION_ID.test(id)) throw new Error(`Invalid ${label}: ${value}`);
  return id;
}

/** A non-empty string, or a function of the screen's params resolved when the header renders. */
function requireScreenTitle(screenId: string, title: unknown): PluginScreenTitle<PluginText> {
  if (typeof title === "function") return title as PluginScreenTitle<PluginText>;
  try {
    return requirePluginText(title);
  } catch {}
  throw new Error(`Screen ${screenId} needs a title: a non-empty string or a function of params`);
}

export type PluginClientRuntime = Pick<
  PluginClientContext,
  | "i18n"
  | "composer"
  | "playAudio"
  | "pimi"
  | "rpc"
  | "openSettings"
  | "openScreen"
  | "openPanel"
  | "subscribe"
  | "addComposerPill"
  | "addHeaderButton"
  | "navigation"
  | "storage"
> & { hosts: ReturnType<typeof createPluginHosts> };

const POINT_ID = /^[a-z][A-Za-z0-9.-]*$/;
const MENU_IDS = new Set<string>(["file-tree-row", "sidebar-workspace-row", "chat-message"]);
const SHORTCUT_PATTERN = /^[a-z0-9+\-[\]\\/,.;'`=]+$/i;

function requirePointId(value: unknown, label: string): string {
  if (typeof value !== "string" || !POINT_ID.test(value)) {
    throw new Error(`Invalid ${label}: ${String(value)}`);
  }
  return value;
}

function normalizeOrder(value: number | undefined, label: string): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value)) throw new Error(`${label} order must be a finite number`);
  return value;
}

/** The modules a client bundle may import. The compiler reads the same list, so they cannot drift. */
const HOST_MODULES = (
  runtime: PluginClientRuntime,
): Record<PluginClientHostModule, () => unknown> => ({
  "@pimi/plugin": () => pluginSharedRuntime,
  "@pimi/plugin/client": () => ({
    ...pluginClientRuntime,
    ...hostApi,
    useSettings,
    openExternalUrl,
    getPimiClient: (serverId: string) => runtime.hosts.getPimiClient(serverId),
    useHosts: () =>
      React.useSyncExternalStore(
        runtime.hosts.subscribe,
        runtime.hosts.getSnapshot,
        runtime.hosts.getSnapshot,
      ),
  }),
  "@pimi/plugin/client/ui": () => pluginUiRuntime,
  react: () => React,
  "react/jsx-runtime": () => ReactJsxRuntime,
  "react-native": () => ReactNative,
  zod: () => Zod,
  "@tanstack/react-query": () => ReactQuery,
  "react-native-svg": () => ReactNativeSvg,
  "react-native-reanimated": () => ReactNativeReanimated,
  "react-native-gesture-handler": () => ReactNativeGestureHandler,
  "react-native-safe-area-context": () => ReactNativeSafeAreaContext,
});

export function runPluginClientBundle(
  id: string,
  bundle: string,
  runtime: PluginClientRuntime,
  onChange: () => void = () => undefined,
): EvaluatedPlugin {
  const collector: Omit<EvaluatedPlugin, "id" | "cleanup"> = {
    surfaces: [],
    settingsScreens: [],
    sidebarItems: { header: [], footer: [] },
    filePanels: [],
    workspacePanels: [],
    commandCenterItems: [],
    clientSlashCommands: [],
    attachmentSources: [],
    attachmentRenderers: [],
    themes: [],
    timelineTransformers: [],
    timelineRenderers: [],
    componentLayers: [],
    slotItems: [],
    menuItems: [],
  };
  const surfaceIds = new Set<string>();
  const settingsScreenIds = new Set<string>();
  const sidebarItemIds: Record<PluginSidebarSection, Set<string>> = {
    header: new Set(),
    footer: new Set(),
  };
  const filePanelIds = new Set<string>();
  const workspacePanelIds = new Set<string>();
  const commandCenterItemIds = new Set<string>();
  const clientSlashCommandNames = new Set<string>();
  const attachmentSourceIds = new Set<string>();
  const attachmentRendererKinds = new Set<string>();
  const themeIds = new Set<string>();
  const timelineTransformerIds = new Set<string>();
  const timelineRendererIds = new Set<string>();
  const slotItemIds = new Set<string>();
  const menuItemIds = new Set<string>();
  const removals = new Set<PluginCleanup>();
  let setupComplete = false;
  let stopped = false;
  function trackButton(
    registration: PluginButtonRegistration<PluginText>,
  ): PluginButtonRegistration<PluginText> {
    let active = true;
    const remove = () => {
      if (!active) return;
      active = false;
      registration.remove();
      removals.delete(remove);
    };
    removals.add(remove);
    return {
      update: (patch) => {
        if (active && !stopped) registration.update(patch);
      },
      remove,
    };
  }
  const notifyChange = () => {
    if (setupComplete) onChange();
  };
  function register<T>(items: T[], item: T, release: () => void): PluginCleanup {
    items.push(item);
    notifyChange();
    let active = true;
    const remove = () => {
      if (!active) return;
      active = false;
      const index = items.indexOf(item);
      if (index !== -1) items.splice(index, 1);
      release();
      removals.delete(remove);
      notifyChange();
    };
    removals.add(remove);
    return remove;
  }
  function addSidebarItem(
    section: PluginSidebarSection,
    contribution: PluginSidebarItemContribution,
  ): PluginCleanup {
    const ids = sidebarItemIds[section];
    const normalizedId = requireId(contribution.id, `sidebar ${section} item id`);
    if (ids.has(normalizedId))
      throw new Error(`Duplicate sidebar ${section} item: ${normalizedId}`);
    const title = normalizePluginText(contribution.title);
    if (!title) throw new Error(`Sidebar item ${normalizedId} has no title`);
    if (!isComponentType(contribution.Component)) {
      throw new Error(`Sidebar item ${normalizedId} is not a component`);
    }
    ids.add(normalizedId);
    return register(
      collector.sidebarItems[section],
      { id: normalizedId, title, Component: contribution.Component },
      () => ids.delete(normalizedId),
    );
  }
  function registerPanel(contribution: PluginWorkspacePanelContribution): PluginCleanup {
    const normalizedId = requireId(contribution.id, "workspace panel id");
    if (workspacePanelIds.has(normalizedId)) {
      throw new Error(`Duplicate workspace panel: ${normalizedId}`);
    }
    const title = normalizePluginText(contribution.title);
    if (!title) throw new Error(`Workspace panel ${normalizedId} has no title`);
    const icon = parsePluginIcon(`Workspace panel ${normalizedId}`, contribution.icon);
    if (typeof contribution.Component !== "function") {
      throw new Error(`Workspace panel ${normalizedId} is not a component`);
    }
    const locations = normalizePanelLocations(normalizedId, contribution.locations);
    workspacePanelIds.add(normalizedId);
    return register(
      collector.workspacePanels,
      {
        ...contribution,
        id: normalizedId,
        title,
        icon,
        locations,
      },
      () => workspacePanelIds.delete(normalizedId),
    );
  }
  function registerLayer(
    kind: "replacement" | "wrapper",
    tier: "typed" | "unstable",
    pointId: unknown,
    Component: unknown,
    order: number | undefined,
  ): PluginCleanup {
    const point = requirePointId(pointId, "component point id");
    if (!isComponentType(Component)) throw new Error(`Component for ${point} is not a component`);
    return register(
      collector.componentLayers,
      {
        kind,
        point,
        tier,
        order: normalizeOrder(order, `Component ${point}`),
        Component: Component as AnyComponent,
      },
      () => undefined,
    );
  }
  const pluginContext: PluginClientContext = {
    ...runtime,
    addSettingsScreen(contribution) {
      const screenId = requireId(contribution.id, "settings screen id");
      if (settingsScreenIds.has(screenId))
        throw new Error(`Duplicate settings screen: ${screenId}`);
      if (!normalizePluginText(contribution.title))
        throw new Error(`Invalid settings screen: ${screenId}`);
      const icon = parsePluginIcon(`Settings screen ${screenId}`, contribution.icon);
      settingsScreenIds.add(screenId);
      return register(collector.settingsScreens, { ...contribution, id: screenId, icon }, () =>
        settingsScreenIds.delete(screenId),
      );
    },
    addScreen(contribution: PluginScreenContribution) {
      if (typeof contribution !== "object" || contribution === null) {
        throw new Error("addScreen takes { id, title, Component }");
      }
      const normalizedId = requireId(contribution.id, "screen id");
      if (surfaceIds.has(normalizedId)) throw new Error(`Duplicate screen: ${normalizedId}`);
      const title = requireScreenTitle(normalizedId, contribution.title);
      if (!isComponentType(contribution.Component)) {
        throw new Error(`Screen ${normalizedId} is not a component`);
      }
      surfaceIds.add(normalizedId);
      return register(
        collector.surfaces,
        { id: normalizedId, title, Component: contribution.Component },
        () => surfaceIds.delete(normalizedId),
      );
    },
    addSidebarHeaderItem(contribution: PluginSidebarItemContribution) {
      return addSidebarItem("header", contribution);
    },
    addSidebarFooterItem(contribution: PluginSidebarItemContribution) {
      return addSidebarItem("footer", contribution);
    },
    addFilePanel(contribution) {
      const panelId = requireId(contribution.id, "file panel id");
      if (filePanelIds.has(panelId)) throw new Error(`Duplicate file panel: ${panelId}`);
      const title = normalizePluginText(contribution.title);
      if (!title) throw new Error(`File panel ${panelId} has no title`);
      const icon = parsePluginIcon(`File panel ${panelId}`, contribution.icon);
      const files = contribution.files;
      const validEntries = (entries: unknown, extension: boolean): entries is string[] =>
        Array.isArray(entries) &&
        entries.every(
          (entry) =>
            typeof entry === "string" &&
            entry.trim() === entry &&
            entry.length > 0 &&
            !/[\\/*?]/.test(entry) &&
            (!extension || !entry.includes(".")),
        );
      if (
        !files ||
        Object.keys(files).some((key) => key !== "extensions" && key !== "filenames") ||
        !validEntries(files.extensions, true) ||
        (files.filenames !== undefined && !validEntries(files.filenames, false)) ||
        (files.extensions.length === 0 && !files.filenames?.length)
      ) {
        throw new Error(`File panel ${panelId} has invalid selector`);
      }
      if (typeof contribution.Component !== "function")
        throw new Error(`File panel ${panelId} is not a component`);
      filePanelIds.add(panelId);
      return register(
        collector.filePanels,
        {
          ...contribution,
          id: panelId,
          title,
          icon,
          files: {
            extensions: [...files.extensions],
            ...(files.filenames ? { filenames: [...files.filenames] } : {}),
          },
        },
        () => filePanelIds.delete(panelId),
      );
    },
    addAgentPanel(contribution: PluginAgentPanelContribution<PluginText>) {
      return registerPanel({ ...contribution, context: "agent" });
    },
    addWorkspacePanel(contribution: WorkspacePanelInput<PluginText>) {
      return registerPanel({ ...contribution, context: "workspace" });
    },
    addCommandCenterItem(contribution: PluginCommandCenterItemContribution) {
      const normalizedId = requireId(contribution.id, "Command Center item id");
      if (commandCenterItemIds.has(normalizedId)) {
        throw new Error(`Duplicate Command Center item: ${normalizedId}`);
      }
      const title = normalizePluginText(contribution.title);
      if (!title) throw new Error(`Command Center item ${normalizedId} has no title`);
      const icon = parsePluginIcon(`Command Center item ${normalizedId}`, contribution.icon);
      if (
        contribution.context !== "global" &&
        contribution.context !== "workspace" &&
        contribution.context !== "agent"
      ) {
        throw new Error(`Command Center item ${normalizedId} has invalid context`);
      }
      if (typeof contribution.onSelect !== "function") {
        throw new Error(`Command Center item ${normalizedId} has no callback`);
      }
      if (contribution.shortcut !== undefined) {
        const shortcut = contribution.shortcut.trim().toLowerCase();
        if (!shortcut || !SHORTCUT_PATTERN.test(shortcut)) {
          throw new Error(`Command Center item ${normalizedId} has an invalid shortcut`);
        }
      }
      commandCenterItemIds.add(normalizedId);
      return register(
        collector.commandCenterItems,
        {
          ...contribution,
          id: normalizedId,
          title,
          shortcut: contribution.shortcut?.trim().toLowerCase(),
          icon,
          keywords: contribution.keywords?.map((keyword) => keyword.trim()).filter(Boolean),
        },
        () => commandCenterItemIds.delete(normalizedId),
      );
    },
    addSlashCommand(contribution: PluginClientSlashCommandContribution) {
      const name = requireId(contribution.name, "client slash command name");
      if (clientSlashCommandNames.has(name)) {
        throw new Error(`Duplicate client slash command: ${name}`);
      }
      const description = normalizePluginText(contribution.description);
      if (!description) throw new Error(`Client slash command ${name} has no description`);
      if (contribution.context !== "workspace" && contribution.context !== "agent") {
        throw new Error(`Client slash command ${name} has invalid context`);
      }
      if (typeof contribution.onSubmit !== "function") {
        throw new Error(`Client slash command ${name} has no callback`);
      }
      clientSlashCommandNames.add(name);
      return register(
        collector.clientSlashCommands,
        {
          ...contribution,
          name,
          description,
          argumentHint: normalizePluginText(contribution.argumentHint),
        },
        () => clientSlashCommandNames.delete(name),
      );
    },
    addAttachmentSource(contribution: PluginAttachmentSourceContribution) {
      const normalizedId = requireId(contribution.id, "attachment source id");
      if (attachmentSourceIds.has(normalizedId)) {
        throw new Error(`Duplicate attachment source: ${normalizedId}`);
      }
      const title = normalizePluginText(contribution.title);
      const pickerTitle = normalizePluginText(contribution.pickerTitle);
      const searchPlaceholder = normalizePluginText(contribution.searchPlaceholder);
      const method = contribution.search.name.trim();
      if (!title) throw new Error(`Attachment source ${normalizedId} has no title`);
      const icon = parseSerializablePluginIcon(
        `Attachment source ${normalizedId}`,
        contribution.icon,
      );
      if (!pickerTitle) throw new Error(`Attachment source ${normalizedId} has no picker title`);
      if (!searchPlaceholder) {
        throw new Error(`Attachment source ${normalizedId} has no search placeholder`);
      }
      if (!method) throw new Error(`Attachment source ${normalizedId} has no search RPC`);
      attachmentSourceIds.add(normalizedId);
      return register(
        collector.attachmentSources,
        {
          id: normalizedId,
          title,
          icon,
          pickerTitle,
          searchPlaceholder,
          search: { ...contribution.search, name: method },
        },
        () => attachmentSourceIds.delete(normalizedId),
      );
    },
    addAttachmentRenderer(contribution: PluginAttachmentRendererContribution) {
      const kind = contribution.kind;
      if (!ATTACHMENT_RENDERER_KINDS.has(kind)) {
        throw new Error(`Attachment renderer has invalid kind: ${String(kind)}`);
      }
      if (attachmentRendererKinds.has(kind)) {
        throw new Error(`Duplicate attachment renderer: ${kind}`);
      }
      if (!isComponentType(contribution.Component)) {
        throw new Error(`Attachment renderer ${kind} is not a component`);
      }
      attachmentRendererKinds.add(kind);
      return register(collector.attachmentRenderers, { ...contribution }, () =>
        attachmentRendererKinds.delete(kind),
      );
    },
    addTheme(contribution: PluginThemeContribution) {
      const normalizedId = requireId(contribution.id, "theme id");
      if (themeIds.has(normalizedId)) throw new Error(`Duplicate theme: ${normalizedId}`);
      const theme = parsePluginThemeContribution({ ...contribution, id: normalizedId });
      themeIds.add(normalizedId);
      return register(collector.themes, theme, () => themeIds.delete(normalizedId));
    },
    addTimelineTransformer(contribution: PluginTimelineTransformerContribution) {
      const normalizedId = requireId(contribution.id, "timeline transformer id");
      if (timelineTransformerIds.has(normalizedId)) {
        throw new Error(`Duplicate timeline transformer: ${normalizedId}`);
      }
      if (!contribution.query || typeof contribution.query.itemType !== "string") {
        throw new Error(`Timeline transformer ${normalizedId} has no item type`);
      }
      if (!TIMELINE_ITEM_TYPES.has(contribution.query.itemType)) {
        throw new Error(
          `Timeline transformer ${normalizedId} has invalid item type: ${contribution.query.itemType}`,
        );
      }
      if (typeof contribution.transform !== "function") {
        throw new Error(`Timeline transformer ${normalizedId} has no transform`);
      }
      if (contribution.id !== normalizedId) {
        throw new Error(`Invalid timeline transformer id: ${contribution.id}`);
      }
      timelineTransformerIds.add(normalizedId);
      return register(collector.timelineTransformers, contribution, () =>
        timelineTransformerIds.delete(normalizedId),
      );
    },
    addTimelineRenderer(contribution: PluginTimelineRendererContribution) {
      const kind = requireId(contribution.kind, "timeline renderer kind");
      if (!Number.isInteger(contribution.version) || contribution.version < 1) {
        throw new Error(`Timeline renderer ${kind} has invalid version`);
      }
      const rendererId = `${kind}/${contribution.version}`;
      if (timelineRendererIds.has(rendererId)) {
        throw new Error(`Duplicate timeline renderer: ${rendererId}`);
      }
      if (!contribution.schema || typeof contribution.schema.safeParse !== "function") {
        throw new Error(`Timeline renderer ${rendererId} has no schema`);
      }
      if (typeof contribution.Component !== "function") {
        throw new Error(`Timeline renderer ${rendererId} is not a component`);
      }
      timelineRendererIds.add(rendererId);
      return register(collector.timelineRenderers, { ...contribution, kind }, () =>
        timelineRendererIds.delete(rendererId),
      );
    },
    overrideComponent(pointId, Component, options) {
      return registerLayer("replacement", "typed", pointId, Component, options?.order);
    },
    wrapComponent(pointId, Wrapper, options) {
      return registerLayer("wrapper", "typed", pointId, Wrapper, options?.order);
    },
    unstable: {
      overrideComponent(pointId, Component, options) {
        return registerLayer("replacement", "unstable", pointId, Component, options?.order);
      },
      wrapComponent(pointId, Wrapper, options) {
        return registerLayer("wrapper", "unstable", pointId, Wrapper, options?.order);
      },
    },
    addToSlot(slotId, item) {
      const slot = requirePointId(slotId, "slot id");
      const itemId = requireId(item.id, "slot item id");
      const key = `${slot}/${itemId}`;
      if (slotItemIds.has(key)) throw new Error(`Duplicate slot item: ${key}`);
      if (!isComponentType(item.Component)) throw new Error(`Slot item ${key} is not a component`);
      slotItemIds.add(key);
      return register(
        collector.slotItems,
        {
          slot,
          id: itemId,
          order: normalizeOrder(item.order, `Slot item ${key}`),
          Component: item.Component,
        },
        () => slotItemIds.delete(key),
      );
    },
    addMenuItem(contribution) {
      const menu: PluginMenuId = contribution.menu;
      if (!MENU_IDS.has(menu)) throw new Error(`Unknown menu: ${String(menu)}`);
      const itemId = requireId(contribution.id, "menu item id");
      const key = `${menu}/${itemId}`;
      if (menuItemIds.has(key)) throw new Error(`Duplicate menu item: ${key}`);
      const title = normalizePluginText(contribution.title);
      if (!title) throw new Error(`Menu item ${key} has no title`);
      if (typeof contribution.run !== "function") throw new Error(`Menu item ${key} has no run`);
      if (contribution.when !== undefined && typeof contribution.when !== "function") {
        throw new Error(`Menu item ${key} has an invalid when`);
      }
      menuItemIds.add(key);
      return register(
        collector.menuItems,
        { ...contribution, id: itemId, title } as PluginMenuItemContribution,
        () => menuItemIds.delete(key),
      );
    },
    addComposerPill(contribution) {
      if (stopped) throw new Error("Plugin has stopped");
      return trackButton(runtime.addComposerPill(contribution));
    },
    addHeaderButton(contribution) {
      if (stopped) throw new Error("Plugin has stopped");
      return trackButton(runtime.addHeaderButton(contribution));
    },
  };
  const hostModules = HOST_MODULES(runtime);
  const runtimeRequire = (name: string): unknown => {
    if (!Object.hasOwn(hostModules, name)) {
      throw new Error(`Module "${name}" is not available in plugin client code`);
    }
    return hostModules[name as PluginClientHostModule]();
  };
  const evaluate: (source: string) => unknown = globalThis.eval;
  const factory = evaluate(bundle);
  if (typeof factory !== "function")
    throw new Error(`Plugin ${id} client bundle is not executable`);
  const exports = factory(runtimeRequire);
  const setup =
    exports !== null && typeof exports === "object" ? Reflect.get(exports, "default") : undefined;
  if (typeof setup !== "function") {
    throw new Error(`Plugin ${id} must default export a function`);
  }
  let entryCleanup: PluginCleanup | undefined;
  try {
    entryCleanup = setup(pluginContext);
    if (typeof entryCleanup !== "function")
      throw new Error(`Plugin ${id} contribution must return a cleanup function`);
  } catch (error) {
    stopped = true;
    try {
      void Promise.resolve(
        typeof entryCleanup === "function" ? entryCleanup() : entryCleanup,
      ).catch((cleanupError) => {
        console.warn(`[Plugins] Cleanup failed after setup error for ${id}`, cleanupError);
      });
    } catch (cleanupError) {
      console.warn(`[Plugins] Cleanup failed after setup error for ${id}`, cleanupError);
    } finally {
      for (const remove of removals) remove();
    }
    throw error;
  }
  setupComplete = true;
  const cleanupEntry = entryCleanup;
  const cleanup = async () => {
    if (stopped) return;
    stopped = true;
    try {
      await cleanupEntry();
    } finally {
      for (const remove of removals) remove();
    }
  };
  return {
    id,
    cleanup,
    surfaces: collector.surfaces,
    settingsScreens: collector.settingsScreens,
    sidebarItems: collector.sidebarItems,
    filePanels: collector.filePanels,
    workspacePanels: collector.workspacePanels as EvaluatedPlugin["workspacePanels"],
    commandCenterItems: collector.commandCenterItems,
    clientSlashCommands: collector.clientSlashCommands,
    attachmentSources: collector.attachmentSources,
    attachmentRenderers: collector.attachmentRenderers,
    themes: collector.themes,
    timelineTransformers: collector.timelineTransformers,
    timelineRenderers: collector.timelineRenderers,
    componentLayers: collector.componentLayers,
    slotItems: collector.slotItems,
    menuItems: collector.menuItems,
  };
}
