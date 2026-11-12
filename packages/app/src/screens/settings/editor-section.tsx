import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { Switch } from "@/components/ui/switch";
import { useAppSettings } from "@/hooks/use-settings";
import { SettingAnchor } from "@/settings-index/anchor";
import { settingsStyles } from "@/styles/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";

export function EditorSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const handleChange = useCallback(
    (vimKeybindings: boolean) => void updateSettings({ vimKeybindings }),
    [updateSettings],
  );
  return (
    <SettingsSection title={t("settings.editor.title")}>
      <View style={settingsStyles.card}>
        <SettingAnchor id="editor.vim" style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.editor.vimKeybindings")}</Text>
            <Text style={settingsStyles.rowHint}>{t("settings.editor.vimHint")}</Text>
          </View>
          <Switch
            value={settings.vimKeybindings}
            onValueChange={handleChange}
            accessibilityLabel={t("settings.editor.vimKeybindings")}
            testID="vim-keybindings-toggle"
          />
        </SettingAnchor>
      </View>
    </SettingsSection>
  );
}
