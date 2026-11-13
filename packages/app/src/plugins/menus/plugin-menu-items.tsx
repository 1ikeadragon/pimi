import { useCallback, useMemo, type ReactElement } from "react";
import { withUnistyles } from "react-native-unistyles";
import type { PluginMenuId, PluginMenus } from "@pimi/plugin/client";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useToast } from "@/contexts/toast-context";
import type { Theme } from "@/styles/theme";
import { PluginIconView } from "../icons";
import { useInstalledPlugins } from "../registry";
import type { InstalledPlugin, PluginMenuItemContribution } from "../types";

const ThemedPluginIcon = withUnistyles(PluginIconView);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface MenuEntry {
  key: string;
  plugin: InstalledPlugin;
  item: PluginMenuItemContribution;
}

/**
 * The plugin items for one menu. App-wide like other UI contributions: an item a plugin declares on
 * several hosts appears once, from the first host by id.
 */
function collectMenuEntries(
  installed: readonly InstalledPlugin[],
  menu: PluginMenuId,
): MenuEntry[] {
  const byKey = new Map<string, MenuEntry>();
  const ordered = [...installed].sort((left, right) => (left.serverId < right.serverId ? -1 : 1));
  for (const plugin of ordered) {
    for (const item of plugin.menuItems) {
      if (item.menu !== menu) continue;
      const key = `${plugin.id}:${item.id}`;
      if (!byKey.has(key)) byKey.set(key, { key, plugin, item });
    }
  }
  return [...byKey.values()].sort((left, right) => (left.key < right.key ? -1 : 1));
}

function isVisible(item: PluginMenuItemContribution, context: PluginMenus[PluginMenuId]): boolean {
  if (!item.when) return true;
  try {
    return (item.when as (context: PluginMenus[PluginMenuId]) => boolean)(context);
  } catch (error) {
    console.warn(`[Plugins] Menu item ${item.id} failed in when()`, error);
    return false;
  }
}

/**
 * Renders the items plugins added to a core menu. Drop it as the last child of the menu's content,
 * with the same surface the menu uses. Renders nothing when no plugin adds to the menu.
 */
export function PluginMenuItems<Id extends PluginMenuId>({
  menu,
  context,
  surface,
}: {
  menu: Id;
  context: PluginMenus[Id];
  surface: "context" | "dropdown";
}): ReactElement | null {
  const installed = useInstalledPlugins();
  const entries = useMemo(() => collectMenuEntries(installed, menu), [installed, menu]);
  if (entries.length === 0) return null;
  const visible = entries.filter((entry) => isVisible(entry.item, context));
  if (visible.length === 0) return null;
  return (
    <>
      {visible.map((entry) => (
        <PluginMenuEntryItem key={entry.key} entry={entry} context={context} surface={surface} />
      ))}
    </>
  );
}

function PluginMenuEntryItem<Id extends PluginMenuId>({
  entry,
  context,
  surface,
}: {
  entry: MenuEntry;
  context: PluginMenus[Id];
  surface: "context" | "dropdown";
}): ReactElement {
  const { plugin, item, key } = entry;
  const toast = useToast();
  const Item = surface === "context" ? ContextMenuItem : DropdownMenuItem;
  const leading = useMemo(
    () =>
      item.icon ? (
        <ThemedPluginIcon icon={item.icon} size={14} uniProps={mutedIconMapping} />
      ) : undefined,
    [item.icon],
  );
  const onSelect = useCallback(() => {
    void Promise.resolve()
      .then(() => (item.run as (context: PluginMenus[Id]) => void | Promise<void>)(context))
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : String(error));
      });
  }, [context, item, toast]);
  return (
    <Item testID={`plugin-menu-item-${key}`} leading={leading} onSelect={onSelect}>
      {plugin.i18n.resolve(item.title, plugin.locale)}
    </Item>
  );
}
