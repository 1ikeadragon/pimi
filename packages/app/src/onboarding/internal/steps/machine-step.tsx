import { useCallback } from "react";
import { useTranslation } from "@/i18n/use-translation";
import { useRouter } from "expo-router";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SettingsCard, SettingsDetailRow } from "@/components/settings";
import { useAddHost } from "@/hosts/add-host";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";
import { getOnboardingModel } from "../onboarding-instance";

/**
 * Where agents run: this computer (continue setup here) or a remote dev machine over SSH, which
 * Pimi installs and starts. A connected remote becomes the host you work in, so setup ends there.
 */
export function MachineStep({ onUseThisComputer }: { onUseThisComputer: () => void }) {
  const { t } = useTranslation();
  const router = useRouter();
  const handleRemoteAdded = useCallback(
    (serverId: string) => {
      void getOnboardingModel().complete();
      router.replace(buildNewWorkspaceRoute({ serverId, chooseProject: true }));
    },
    [router],
  );
  const openRemoteSsh = useAddHost({ method: "ssh", onAdded: handleRemoteAdded });
  return (
    <View style={styles.container}>
      <SettingsCard>
        <SettingsDetailRow
          label={t("remoteDev.onboarding.localTitle")}
          hint={t("remoteDev.onboarding.localHint")}
          onPress={onUseThisComputer}
          testID="onboarding-machine-local"
        />
        <SettingsDetailRow
          label={t("remoteDev.onboarding.remoteTitle")}
          hint={t("remoteDev.onboarding.remoteHint")}
          onPress={openRemoteSsh}
          testID="onboarding-machine-remote-ssh"
        />
      </SettingsCard>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { gap: theme.spacing[4] },
}));
