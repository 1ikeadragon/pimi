import { useCallback } from "react";
import { Text, View } from "react-native";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Switch } from "@/components/ui/switch";
import { useDesktopSettings } from "@/desktop/settings/desktop-settings";
import { useTranslation } from "@/i18n/use-translation";
import { getIsElectron } from "@/constants/platform";
import { SettingAnchor } from "@/settings-index/anchor";
import { settingsStyles } from "@/styles/settings";

export function DesktopPowerSection() {
  const { t } = useTranslation();
  const { settings, isSaving, updateSettings } = useDesktopSettings();

  const handleChange = useCallback(
    (alwaysKeepAwake: boolean) => {
      void updateSettings({ power: { alwaysKeepAwake } }).catch(() => {
        // useDesktopSettings owns the user-visible IPC error.
      });
    },
    [updateSettings],
  );

  if (!getIsElectron()) {
    return null;
  }

  return (
    <SettingsSection title={t("settings.power.title")}>
      <View style={settingsStyles.card}>
        <SettingAnchor id="power.alwaysKeepAwake" style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.power.alwaysKeepAwake")}</Text>
            <Text style={settingsStyles.rowHint}>{t("settings.power.alwaysKeepAwakeHint")}</Text>
          </View>
          <Switch
            value={settings.power.alwaysKeepAwake}
            onValueChange={handleChange}
            disabled={isSaving}
            accessibilityLabel={t("settings.power.alwaysKeepAwake")}
            testID="desktop-power-always-keep-awake-switch"
          />
        </SettingAnchor>
      </View>
    </SettingsSection>
  );
}
