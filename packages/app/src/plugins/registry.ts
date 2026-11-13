import type { AnyComponent } from "@/extension-points/registry";
import { PluginTranslationRuntime } from "@pimi/plugin/client/host";
import { i18n } from "@/i18n/i18next";
import type { AudioEngine } from "@/audio";
import { useMemo, useSyncExternalStore } from "react";
import { QueryClient } from "@tanstack/react-query";
import { createPimiApi } from "@pimi/client";
import type { DaemonClient } from "@pimi/client/internal/daemon-client";
import { assertPluginCompatibility } from "@pimi/protocol/plugin-requirements";
import { resolveAppVersion } from "@/utils/app-version";
import { createPluginClientRuntime } from "./client-runtime";
import { createPluginSubscribe } from "./subscriptions";
import { runPluginClientBundle } from "./evaluate";
import type { InstalledPlugin } from "./types";
import { extensionRegistry } from "@/extension-points";
import { createPluginStorage } from "./storage";
import { getPreferredPluginContributionHost, pluginUiHostKey } from "./contribution-host";
import { PluginInstallationProvider } from "./installation-provider";
import { createElement, type ComponentType, type ReactNode } from "react";

type CatalogPlugin = Awaited<ReturnType<DaemonClient["getPluginCatalog"]>>[number];
export type PluginCatalogStatus = "loading" | "ready" | "error";

const UNAVAILABLE_NAVIGATION: InstalledPlugin["navigation"] = new Proxy(
  {} as InstalledPlugin["navigation"],
  {
    get() {
      throw new Error("Plugin is still loading");
    },
  },
);
const UNAVAILABLE_HOSTS: InstalledPlugin["hosts"] = new Proxy({} as InstalledPlugin["hosts"], {
  get() {
    throw new Error("Plugin is still loading");
  },
});

const layerComponents = new WeakMap<object, ComponentType<Record<string, unknown>>>();

/** Renders a plugin's layer under its installation, so hooks and the theme work outside the plugin's own surfaces. */
function withInstallation(
  plugin: InstalledPlugin,
  registration: object,
  Component: AnyComponent,
): ComponentType<Record<string, unknown>> {
  const cached = layerComponents.get(registration);
  if (cached) return cached;
  function PluginLayer(props: Record<string, unknown>): ReactNode {
    const Layer = Component as ComponentType<Record<string, unknown>>;
    return createElement(
      PluginInstallationProvider as ComponentType<{ plugin: InstalledPlugin }>,
      { plugin },
      createElement(Layer, props),
    );
  }
  PluginLayer.displayName = `PluginLayer(${plugin.id})`;
  layerComponents.set(registration, PluginLayer);
  return PluginLayer;
}

interface AppliedExtensions {
  plugin: InstalledPlugin;
  layers: readonly object[];
  slots: readonly object[];
  release: () => void;
}

export class PluginRegistry {
  private readonly appliedExtensions = new Map<string, AppliedExtensions>();
  private readonly byHost = new Map<string, InstalledPlugin[]>();
  private readonly listeners = new Set<() => void>();
  private snapshot: InstalledPlugin[] = [];
  private readonly disposed = new WeakSet<InstalledPlugin>();
  private readonly evaluationErrors = new Map<string, string>();
  private readonly catalogStatuses = new Map<string, PluginCatalogStatus>();
  /** The client each host's installations were bound to; their Pimi API and RPCs call it. */
  private readonly clientByHost = new Map<string, DaemonClient>();

  constructor(
    private readonly dependencies: {
      localeSource: import("@pimi/plugin/client/host").PluginLocaleSource;
      version: string | null;
      createRuntime: typeof createPluginClientRuntime;
    },
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): InstalledPlugin[] => this.snapshot;

  getEvaluationError(serverId: string, pluginId: string): string | undefined {
    return this.evaluationErrors.get(`${serverId}/${pluginId}`);
  }

  getCatalogStatus(serverId: string): PluginCatalogStatus {
    return this.catalogStatuses.get(serverId) ?? "loading";
  }

  setCatalogStatus(serverId: string, status: PluginCatalogStatus): void {
    if (this.catalogStatuses.get(serverId) === status) return;
    this.catalogStatuses.set(serverId, status);
    for (const listener of this.listeners) listener();
  }

  installCatalog(
    serverId: string,
    catalog: CatalogPlugin[],
    options: {
      replacePluginId?: string;
      client: DaemonClient;
      audio: Pick<AudioEngine, "play">;
    },
  ): boolean {
    const previous = this.byHost.get(serverId) ?? [];
    const previousErrors = this.hostEvaluationErrors(serverId);
    // Installations call the client they were created with, so a new client replaces them all.
    const sameClient = this.clientByHost.get(serverId) === options.client;
    this.clientByHost.set(serverId, options.client);
    const previousTimelineBundles = previous
      .filter((plugin) => plugin.timelineTransformers.length > 0)
      .map((plugin) => `${plugin.id}\0${plugin.clientBundle}`);
    const preserved = catalog.flatMap((entry) => {
      if (!sameClient) return [];
      const existing = previous.find(
        (plugin) =>
          plugin.id !== options.replacePluginId &&
          plugin.id === entry.id &&
          plugin.clientBundle === entry.clientBundle &&
          plugin.requirements?.pimi === entry.requirements?.pimi,
      );
      return existing ? [existing] : [];
    });
    const removed = previous.filter((plugin) => !preserved.includes(plugin));
    if (removed.length > 0) {
      this.byHost.set(serverId, preserved);
      this.publish();
      for (const plugin of removed) this.dispose(plugin);
    }
    const installed = catalog.flatMap((entry) => {
      const key = `${serverId}/${entry.id}`;
      let installation: InstalledPlugin | undefined;
      try {
        if (!entry.clientBundle) return [];
        assertPluginCompatibility({ ...entry, version: this.dependencies.version, runtime: "app" });
        const existing = preserved.find(
          (plugin) => plugin.id === entry.id && plugin.clientBundle === entry.clientBundle,
        );
        if (existing) {
          this.evaluationErrors.delete(key);
          return [existing];
        }
        const client = options.client;
        const lifetime = new AbortController();
        installation = {
          lifetime,
          locale: this.dependencies.localeSource.getLocale(),
          i18n: new PluginTranslationRuntime(this.dependencies.localeSource),
          pimi: createPimiApi(client),
          invoke: (method, input) => client.invokePluginRpc(entry.id, method, input),
          subscribe: createPluginSubscribe({
            client,
            pluginId: entry.id,
            lifetime: lifetime.signal,
          }),
          id: entry.id,
          serverId,
          clientBundle: entry.clientBundle,
          requirements: entry.requirements,
          queryClient: new QueryClient(),
          navigation: UNAVAILABLE_NAVIGATION,
          storage: createPluginStorage(entry.id, lifetime.signal),
          hosts: UNAVAILABLE_HOSTS,
          cleanup: () => undefined,
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
        const unsubscribeTranslations = installation.i18n.subscribe(() => this.publish());
        installation.lifetime.signal.addEventListener("abort", unsubscribeTranslations, {
          once: true,
        });
        const runtime = this.dependencies.createRuntime(installation, options.audio);
        installation.navigation = runtime.navigation;
        installation.hosts = runtime.hosts;
        const evaluated = runPluginClientBundle(entry.id, entry.clientBundle, runtime, () =>
          this.publish(),
        );
        Object.assign(installation, evaluated);
        const pimi = installation.pimi;
        installation.cleanup = async () => {
          const results = await Promise.allSettled([pimi.dispose(), evaluated.cleanup()]);
          const failures = results.filter((result) => result.status === "rejected");
          if (failures.length)
            throw new AggregateError(
              failures.map((result) => result.reason),
              "Plugin cleanup failed",
            );
        };
        this.evaluationErrors.delete(key);
        return [installation];
      } catch (error) {
        installation?.lifetime.abort();
        installation?.i18n.dispose();
        void installation?.pimi
          .dispose()
          .catch((failure) => console.warn(`[Plugins] API cleanup failed for ${key}`, failure));
        this.evaluationErrors.set(key, error instanceof Error ? error.message : String(error));
        console.warn(`[Plugins] Failed to evaluate ${serverId}/${entry.id}`, error);
        return [];
      }
    });
    const configuredIds = new Set(catalog.map((entry) => entry.id));
    for (const key of this.evaluationErrors.keys()) {
      if (key.startsWith(`${serverId}/`) && !configuredIds.has(key.slice(serverId.length + 1))) {
        this.evaluationErrors.delete(key);
      }
    }
    this.byHost.set(serverId, installed);
    // An unchanged catalog keeps the snapshot, so timeline projections cached against the
    // installed transformers stay valid across a reconnect.
    const unchanged =
      installed.length === previous.length &&
      installed.every((plugin, index) => plugin === previous[index]) &&
      this.hostEvaluationErrors(serverId) === previousErrors;
    if (!unchanged) this.publish();
    const installedTimelineBundles = installed
      .filter((plugin) => plugin.timelineTransformers.length > 0)
      .map((plugin) => `${plugin.id}\0${plugin.clientBundle}`);
    return (
      previousTimelineBundles.length !== installedTimelineBundles.length ||
      previousTimelineBundles.some((bundle, index) => bundle !== installedTimelineBundles[index])
    );
  }

  removeHost(serverId: string): void {
    const hadCatalog = this.catalogStatuses.delete(serverId);
    const installed = this.byHost.get(serverId);
    if (!installed) {
      if (hadCatalog) {
        for (const listener of this.listeners) listener();
      }
      return;
    }
    for (const plugin of installed) this.dispose(plugin);
    for (const key of this.evaluationErrors.keys()) {
      if (key.startsWith(`${serverId}/`)) this.evaluationErrors.delete(key);
    }
    this.byHost.delete(serverId);
    this.clientByHost.delete(serverId);
    this.publish();
  }

  private hostEvaluationErrors(serverId: string): string {
    const prefix = `${serverId}/`;
    return JSON.stringify(
      [...this.evaluationErrors].filter(([key]) => key.startsWith(prefix)).sort(),
    );
  }

  private dispose(plugin: InstalledPlugin): void {
    if (this.disposed.has(plugin)) return;
    this.disposed.add(plugin);
    plugin.lifetime.abort();
    plugin.i18n.dispose();
    plugin.queryClient.clear();
    try {
      void Promise.resolve(plugin.cleanup()).catch((error) => {
        console.warn(`[Plugins] Cleanup failed for ${plugin.serverId}/${plugin.id}`, error);
      });
    } catch (error) {
      console.warn(`[Plugins] Cleanup failed for ${plugin.serverId}/${plugin.id}`, error);
    }
  }

  private publish(): void {
    this.snapshot = [...this.byHost.values()]
      .flat()
      // A new presentation snapshot invalidates label selectors without replacing the installation lifetime.
      // eslint-disable-next-line no-map-spread
      .map((plugin) => ({ ...plugin, locale: plugin.i18n.locale }))
      .sort((left, right) =>
        `${left.serverId}/${left.id}`.localeCompare(`${right.serverId}/${right.id}`),
      );
    this.syncExtensions();
    for (const listener of this.listeners) listener();
  }

  /**
   * Component overrides, wrappers, and slot items are app-wide: each plugin id contributes them
   * once, from the host its screens last used, else the first host by id.
   */
  private syncExtensions(): void {
    const candidates = new Map<string, InstalledPlugin[]>();
    for (const installed of this.byHost.values()) {
      for (const plugin of installed) {
        if (plugin.componentLayers.length === 0 && plugin.slotItems.length === 0) continue;
        const list = candidates.get(plugin.id);
        if (list) list.push(plugin);
        else candidates.set(plugin.id, [plugin]);
      }
    }
    for (const [pluginId, applied] of this.appliedExtensions) {
      if (candidates.has(pluginId)) continue;
      applied.release();
      this.appliedExtensions.delete(pluginId);
      extensionRegistry.clearErrors(pluginId);
    }
    for (const [pluginId, plugins] of candidates) {
      const preferred = getPreferredPluginContributionHost(pluginUiHostKey(pluginId));
      const owner =
        plugins.find((plugin) => plugin.serverId === preferred) ??
        [...plugins].sort((left, right) => (left.serverId < right.serverId ? -1 : 1))[0];
      const applied = this.appliedExtensions.get(pluginId);
      if (
        applied &&
        applied.plugin === owner &&
        applied.layers.length === owner.componentLayers.length &&
        applied.layers.every((layer, index) => layer === owner.componentLayers[index]) &&
        applied.slots.length === owner.slotItems.length &&
        applied.slots.every((slot, index) => slot === owner.slotItems[index])
      ) {
        continue;
      }
      applied?.release();
      extensionRegistry.clearErrors(pluginId);
      const releases: (() => void)[] = [];
      for (const layer of owner.componentLayers) {
        const Component = withInstallation(owner, layer, layer.Component);
        const options = { order: layer.order, tier: layer.tier };
        releases.push(
          layer.kind === "replacement"
            ? extensionRegistry.setOverride(layer.point, pluginId, Component, options)
            : extensionRegistry.addWrapper(layer.point, pluginId, Component, options),
        );
      }
      for (const item of owner.slotItems) {
        releases.push(
          extensionRegistry.addSlotItem(item.slot, pluginId, {
            id: item.id,
            order: item.order,
            Component: withInstallation(owner, item, item.Component),
          }),
        );
      }
      this.appliedExtensions.set(pluginId, {
        plugin: owner,
        layers: [...owner.componentLayers],
        slots: [...owner.slotItems],
        release: () => {
          for (const release of releases) release();
        },
      });
    }
  }

  /** True when a plugin installed on this host adds to the app's UI, and which host's copy applies. */
  getUiContributionHost(pluginId: string): string | null {
    return this.appliedExtensions.get(pluginId)?.plugin.serverId ?? null;
  }
}

export const pluginRegistry = new PluginRegistry({
  localeSource: {
    getLocale: () => i18n.resolvedLanguage ?? i18n.language,
    subscribe: (listener) => {
      i18n.on("languageChanged", listener);
      return () => {
        i18n.off("languageChanged", listener);
      };
    },
  },
  version: resolveAppVersion(),
  createRuntime: createPluginClientRuntime,
});

export function useInstalledPlugins(): InstalledPlugin[] {
  return useSyncExternalStore(
    pluginRegistry.subscribe,
    pluginRegistry.getSnapshot,
    pluginRegistry.getSnapshot,
  );
}

export function useInstalledPlugin(serverId: string, pluginId: string): InstalledPlugin | null {
  return (
    useInstalledPlugins().find(
      (plugin) => plugin.serverId === serverId && plugin.id === pluginId,
    ) ?? null
  );
}

export function usePluginCatalogStatus(serverId: string): PluginCatalogStatus {
  return useSyncExternalStore(
    pluginRegistry.subscribe,
    () => pluginRegistry.getCatalogStatus(serverId),
    () => pluginRegistry.getCatalogStatus(serverId),
  );
}

export function usePluginInstallations(pluginId: string): InstalledPlugin[] {
  const installed = useInstalledPlugins();
  return useMemo(() => installed.filter((plugin) => plugin.id === pluginId), [installed, pluginId]);
}
