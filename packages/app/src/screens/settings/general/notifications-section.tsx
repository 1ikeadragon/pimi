import { useCallback } from "react";
import { useTranslation } from "@/i18n/use-translation";
import { SettingsCard, SettingsSection, SettingsSwitch } from "@/components/settings";
import { useAppSettings } from "@/hooks/use-settings";

export function PushNotificationsSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const changePreviews = useCallback(
    (pushPreviews: boolean) => void updateSettings({ pushPreviews }),
    [updateSettings],
  );
  const changeHideWhenLocked = useCallback(
    (pushPreviewsHideWhenLocked: boolean) => void updateSettings({ pushPreviewsHideWhenLocked }),
    [updateSettings],
  );
  return (
    <SettingsSection title={t("settings.general.notifications.title")}>
      <SettingsCard>
        <SettingsSwitch
          settingId="general.pushPreviews"
          label={t("settings.general.notifications.previews.label")}
          hint={t("settings.general.notifications.previews.hint")}
          value={settings.pushPreviews}
          onValueChange={changePreviews}
        />
        <SettingsSwitch
          settingId="general.pushPreviewsHideWhenLocked"
          label={t("settings.general.notifications.hideWhenLocked.label")}
          hint={t("settings.general.notifications.hideWhenLocked.hint")}
          value={settings.pushPreviewsHideWhenLocked}
          onValueChange={changeHideWhenLocked}
          disabled={!settings.pushPreviews}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
