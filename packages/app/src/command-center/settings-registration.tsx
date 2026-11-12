import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Settings } from "lucide-react-native";
import { openSettingEntry } from "@/settings-index/open";
import { useSettingsIndex } from "@/settings-index/use-settings-index";
import type { SettingEntry } from "@/settings-index/types";
import { clearCommandCenterFocusRestoreElement } from "@/utils/command-center-focus-restore";
import { getCommandCenterIcon } from "./icon";
import { useCommandCenterActions } from "./provider";
import { buildSettingContributions } from "./settings-contributions";

const SettingsIcon = getCommandCenterIcon(Settings);

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
  const actions = useMemo(
    () =>
      buildSettingContributions({
        entries,
        settingsTitle: t("settings.title"),
        icon: SettingsIcon,
        open,
      }),
    [entries, open, t],
  );
  useCommandCenterActions({ sourceId: "settings", enabled: true, actions });
  return null;
}
