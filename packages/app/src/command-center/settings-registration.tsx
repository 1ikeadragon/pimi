import { useCallback, useMemo } from "react";
import { router } from "expo-router";
import { useTranslation } from "@/i18n/use-translation";
import { useInstalledPlugins } from "@/plugins/registry";
import { pluginDisplayName, usePluginList } from "@/plugins/plugin-list";
import { buildPluginSettingsRoute } from "@/plugins/settings/routes";
import { Settings } from "lucide-react-native";
import { openSettingEntry } from "@/settings-index/open";
import { useSettingsIndex } from "@/settings-index/use-settings-index";
import type { SettingEntry } from "@/settings-index/types";
import { clearCommandCenterFocusRestoreElement } from "@/utils/command-center-focus-restore";
import { getCommandCenterIcon } from "./icon";
import { useCommandCenterActions } from "./provider";
import {
  buildPluginSettingsContributions,
  buildSettingContributions,
} from "./settings-contributions";

const SettingsIcon = getCommandCenterIcon(Settings);
/** Room for any one plugin's screens between the next plugin's. */
const PLUGIN_SCREEN_RANK_SPAN = 100;

/** Registers every Settings page and field with the palette. Mounted once, at the app root. */
export function CommandCenterSettingsActions() {
  const { t } = useTranslation();
  const { entries, serverId } = useSettingsIndex();
  const open = useCallback(
    (entry: SettingEntry) => {
      // Focus belongs to the field being revealed, not to wherever the palette opened from.
      clearCommandCenterFocusRestoreElement();
      openSettingEntry(entry, serverId);
    },
    [serverId],
  );
  const installed = useInstalledPlugins();
  const pluginList = usePluginList(serverId ?? "", { enabled: serverId !== null });
  const actions = useMemo(() => {
    const own = buildSettingContributions({
      entries,
      settingsTitle: t("settings.title"),
      icon: SettingsIcon,
      open,
    });
    const names = new Map(
      (pluginList.data ?? []).map((plugin) => [plugin.id, pluginDisplayName(plugin)]),
    );
    const plugins = installed
      .filter((plugin) => plugin.serverId === serverId)
      .flatMap((plugin, index) =>
        buildPluginSettingsContributions({
          pluginId: plugin.id,
          pluginName: names.get(plugin.id) ?? plugin.id,
          screens: plugin.settingsScreens.map((screen) => ({
            id: screen.id,
            title: plugin.i18n.resolve(screen.title, plugin.locale),
          })),
          firstRank: entries.length + index * PLUGIN_SCREEN_RANK_SPAN,
          icon: SettingsIcon,
          open: (pluginId, screenId) => {
            clearCommandCenterFocusRestoreElement();
            if (serverId) router.navigate(buildPluginSettingsRoute(serverId, pluginId, screenId));
          },
        }),
      );
    return [...own, ...plugins];
  }, [entries, installed, open, pluginList.data, serverId, t]);
  useCommandCenterActions({ sourceId: "settings", enabled: true, actions });
  return null;
}
