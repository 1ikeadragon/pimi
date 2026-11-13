import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "@/i18n/use-translation";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { RotateCw } from "lucide-react-native";
import { AttackAccess, useAttackAccess } from "@/attack/attack-mode-access";
import { SettingsCard, SettingsRow } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { DesktopPermissionRow } from "@/desktop/components/desktop-permission-row";
import { useDesktopPermissions } from "@/desktop/permissions/use-desktop-permissions";
import { settingsStyles } from "@/styles/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";

const ThemedRotateCw = withUnistyles(RotateCw, (theme) => ({
  size: theme.iconSize.md,
  color: theme.colors.foregroundMuted,
}));

/** Re-runs the setup step's permission request, for a grant skipped or revoked since. macOS only. */
function AttackAccessSettings() {
  const { t } = useTranslation();
  const access = useAttackAccess();
  const { macAccess, request } = access;
  const [shown, setShown] = useState(false);
  const setUp = useCallback(() => {
    setShown(true);
    void request();
  }, [request]);
  if (!macAccess) return null;
  return (
    <SettingsSection title={t("attack.setup.title")}>
      <SettingsCard>
        <SettingsRow
          settingId="permissions.attackAccess"
          label={t("attack.setup.label")}
          hint={t("attack.setup.hint")}
        >
          <Button variant="outline" size="sm" onPress={setUp} testID="settings-attack-access">
            {t("attack.setup.button")}
          </Button>
        </SettingsRow>
        {shown ? (
          <View style={styles.access}>
            <AttackAccess attack={access} />
          </View>
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}

export function DesktopPermissionsSection() {
  const { t } = useTranslation();
  const {
    isDesktopApp,
    snapshot,
    isRefreshing,
    requestingPermission,
    refreshPermissions,
    requestPermission,
  } = useDesktopPermissions();

  const handleRefreshPress = useCallback(() => {
    void refreshPermissions();
  }, [refreshPermissions]);

  const handleRequestMicrophone = useCallback(() => {
    void requestPermission("microphone");
  }, [requestPermission]);

  const isBusy = isRefreshing || requestingPermission !== null;

  const refreshIcon = useMemo(() => <ThemedRotateCw />, []);

  const refreshButton = useMemo(
    () => (
      <Button
        variant="ghost"
        leftIcon={refreshIcon}
        onPress={handleRefreshPress}
        disabled={isBusy}
        accessibilityLabel={t("settings.permissions.refreshAccessibility")}
      >
        {isRefreshing ? t("settings.permissions.refreshing") : t("settings.permissions.refresh")}
      </Button>
    ),
    [refreshIcon, handleRefreshPress, isBusy, isRefreshing, t],
  );

  const permissionLabels = useMemo(
    () => ({
      granted: t("settings.permissions.actions.granted"),
      request: t("settings.permissions.actions.request"),
      requesting: t("settings.permissions.actions.requesting"),
    }),
    [t],
  );

  if (!isDesktopApp) {
    return null;
  }

  return (
    <>
      <SettingsSection title={t("settings.permissions.title")} trailing={refreshButton}>
        <View style={settingsStyles.card}>
          <DesktopPermissionRow
            settingId="permissions.microphone"
            title={t("settings.permissions.microphone")}
            status={snapshot?.microphone ?? null}
            isRequesting={requestingPermission === "microphone"}
            onRequest={handleRequestMicrophone}
            labels={permissionLabels}
          />
        </View>
      </SettingsSection>
      <AttackAccessSettings />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  access: { padding: theme.spacing[3] },
}));
