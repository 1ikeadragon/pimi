import { getPreferredPluginContributionHost, pluginScreensHostKey } from "./contribution-host";
import type { InstalledPlugin, PluginSidebarItemContribution, PluginSidebarSection } from "./types";

export interface PluginSidebarTarget {
  plugin: InstalledPlugin;
  item: PluginSidebarItemContribution;
}

/** One sidebar item, coalesced across every host that contributes it. */
export interface PluginSidebarGroup {
  key: string;
  pluginId: string;
  contributionId: string;
  title: string;
  targets: PluginSidebarTarget[];
}

// Stored sidebar order and visibility key header items as `<plugin>/sidebar/<item>`.
function groupKey(pluginId: string, section: PluginSidebarSection, itemId: string) {
  return section === "header"
    ? `${pluginId}/sidebar/${itemId}`
    : `${pluginId}/sidebar-${section}/${itemId}`;
}

export function groupPluginSidebarItems(
  plugins: InstalledPlugin[],
  section: PluginSidebarSection,
): PluginSidebarGroup[] {
  const groups = new Map<string, PluginSidebarGroup>();
  for (const plugin of plugins) {
    for (const item of plugin.sidebarItems[section]) {
      const key = groupKey(plugin.id, section, item.id);
      const existing = groups.get(key);
      if (existing) existing.targets.push({ plugin, item });
      else {
        groups.set(key, {
          key,
          pluginId: plugin.id,
          contributionId: item.id,
          title: plugin.i18n.resolve(item.title, plugin.locale),
          targets: [{ plugin, item }],
        });
      }
    }
  }
  return [...groups.values()];
}

/**
 * The host a group's row uses: the current route's host, else the remembered one, else the first.
 * Items share the host last used with the plugin's screens.
 */
export function selectPluginSidebarTarget(
  group: PluginSidebarGroup,
  currentHostId: string | null,
): PluginSidebarTarget {
  const rememberedHostId = getPreferredPluginContributionHost(pluginScreensHostKey(group.pluginId));
  const targets = group.targets;
  return (
    targets.find((target) => target.plugin.serverId === currentHostId) ??
    targets.find((target) => target.plugin.serverId === rememberedHostId) ??
    targets[0]
  );
}
