import { useCallback, useMemo } from "react";
import { View } from "react-native";
import { useTranslation } from "@/i18n/use-translation";
import {
  SettingsCard,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@/components/settings";
import { isNative } from "@/constants/platform";
import { getDesktopHost } from "@/desktop/host";
import { useAppSettings, type ChatDisplay } from "@/hooks/use-settings";

const CHAT_DISPLAYS: readonly ChatDisplay[] = ["full", "collapseToolCalls", "collapseTurns"];

export function ChatSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();

  const chatDisplayOptions = useMemo(
    () =>
      CHAT_DISPLAYS.map((value) => ({
        value,
        label: t(`settings.general.chatDisplay.options.${value}`),
      })),
    [t],
  );

  const changeChatDisplay = useCallback(
    (chatDisplay: ChatDisplay) => void updateSettings({ chatDisplay }),
    [updateSettings],
  );
  const changeAutoExpandReasoning = useCallback(
    (autoExpandReasoning: boolean) => void updateSettings({ autoExpandReasoning }),
    [updateSettings],
  );
  const changeChatOutline = useCallback(
    (chatOutlineEnabled: boolean) => void updateSettings({ chatOutlineEnabled }),
    [updateSettings],
  );

  const changeVoiceButton = useCallback(
    (pimiVoiceButton: boolean) => void updateSettings({ pimiVoiceButton }),
    [updateSettings],
  );

  return (
    <View>
      {getDesktopHost()?.pimiVoice ? (
        <SettingsSection title="Voice commands">
          <SettingsCard>
            <SettingsSwitch
              settingId="chat.voiceButton"
              label="Show Pimi voice button"
              hint="Open chats and tasks with your voice."
              value={settings.pimiVoiceButton}
              onValueChange={changeVoiceButton}
              testID="settings-pimi-voice-button"
            />
          </SettingsCard>
        </SettingsSection>
      ) : null}
      <SettingsSection title={t("settings.appearance.detailLevel.title")}>
        <SettingsCard>
          <SettingsSwitch
            settingId="chat.autoExpandReasoning"
            label={t("settings.general.autoExpandReasoning.label")}
            hint={t("settings.general.autoExpandReasoning.description")}
            value={settings.autoExpandReasoning}
            onValueChange={changeAutoExpandReasoning}
          />
          <SettingsSelect
            settingId="chat.display"
            label={t("settings.general.chatDisplay.label")}
            hint={t("settings.general.chatDisplay.description")}
            value={settings.chatDisplay}
            options={chatDisplayOptions}
            onValueChange={changeChatDisplay}
          />
          {isNative ? null : (
            <SettingsSwitch
              settingId="chat.outline"
              label={t("settings.appearance.chatOutline.title")}
              hint={t("settings.appearance.chatOutline.description")}
              value={settings.chatOutlineEnabled}
              onValueChange={changeChatOutline}
            />
          )}
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}
