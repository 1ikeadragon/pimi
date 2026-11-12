import { useCallback } from "react";
import { useRouter } from "expo-router";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SettingsCard, SettingsDetailRow } from "@/components/settings";
import { useAddHost } from "@/hosts/add-host";
import { buildHostRootRoute } from "@/utils/host-routes";
import { getOnboardingModel } from "../onboarding-instance";

/**
 * Where agents run: this computer (continue setup here) or a remote dev machine over SSH, which
 * Pimi installs and starts. A connected remote becomes the host you work in, so setup ends there.
 */
export function MachineStep({ onUseThisComputer }: { onUseThisComputer: () => void }) {
  const router = useRouter();
  const handleRemoteAdded = useCallback(
    (serverId: string) => {
      void getOnboardingModel().complete();
      router.replace(buildHostRootRoute(serverId));
    },
    [router],
  );
  const openRemoteSsh = useAddHost({ method: "ssh", onAdded: handleRemoteAdded });
  return (
    <View style={styles.container}>
      <SettingsCard>
        <SettingsDetailRow
          label="Use this computer"
          hint="Agents run here, on your own files. Nothing to install."
          onPress={onUseThisComputer}
          testID="onboarding-machine-local"
        />
        <SettingsDetailRow
          label="Connect a remote dev machine over SSH"
          hint="Enter user@devbox. Pimi installs its daemon there over ssh and runs agents, terminals and git on that machine."
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
