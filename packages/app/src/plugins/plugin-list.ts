import type { PluginListItem } from "@pimi/protocol/messages";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

/** A host's configured plugins, as listed on Settings → Plugins. One cache entry per host. */
export function usePluginList(serverId: string, options: { enabled?: boolean } = {}) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  return useFetchQuery({
    queryKey: ["plugins", serverId] as const,
    queryFn: async () => {
      if (!client) throw new Error("Plugin host is offline");
      return client.listPlugins();
    },
    enabled: (options.enabled ?? true) && Boolean(client && connected),
    dataShape: "list",
    staleTimeMs: 1_000,
  });
}

/** The manifest's display name, or the plugin id when it has none. */
export function pluginDisplayName(plugin: Pick<PluginListItem, "id" | "name">): string {
  return plugin.name ?? plugin.id;
}

/** The display name of one configured plugin; its id until the list loads. */
export function usePluginDisplayName(
  target: { serverId: string; pluginId: string } | null,
): string | undefined {
  const plugins = usePluginList(target?.serverId ?? "", { enabled: target !== null });
  if (!target) return undefined;
  const plugin = plugins.data?.find((candidate) => candidate.id === target.pluginId);
  return plugin ? pluginDisplayName(plugin) : target.pluginId;
}
