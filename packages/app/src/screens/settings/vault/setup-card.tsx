import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { StyleSheet } from "react-native-unistyles";
import { VAULT_MIN_PASSPHRASE_LENGTH } from "@pimi/protocol/vault/types";
import { SettingsCard } from "@/components/settings";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useTranslation } from "@/i18n/use-translation";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { SettingAnchor } from "@/settings-index/anchor";
import { settingsStyles } from "@/styles/settings";
import { SecretInputForm } from "./secret-input-form";
import { useCanUseTouchId, vaultErrorMessage, vaultRoot } from "./use-vault";

interface SetupCardProps {
  serverId: string;
  /** The host's vault switch is already on and only the vault file is missing. */
  enabled: boolean;
}

/**
 * One card from off to a vault in use. Each call stands on its own: if a later one fails the
 * earlier ones are kept and the page then shows the next step with the error.
 */
export function SetupCard({ serverId, enabled }: SetupCardProps) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const queryClient = useQueryClient();
  const { patchConfig } = useDaemonConfig(serverId);
  const canUseTouchId = useCanUseTouchId(serverId);
  const [touchId, setTouchId] = useState(false);
  const turnOn = useMutation({
    mutationFn: async (passphrase: string) => {
      if (!client) throw new Error(t("settings.vault.offlineTitle"));
      if (!enabled) await patchConfig({ vault: { enabled: true } });
      const { status } = await client.vaultGetStatus();
      // A vault file left by an earlier run unlocks with the same passphrase instead of being replaced.
      const opened =
        status.state === "uninitialized"
          ? await client.vaultInitialize({ passphrase })
          : await client.vaultUnlock({ passphrase });
      if (touchId) {
        if (opened.status.quickUnlock === "unavailable") {
          throw new Error(t("settings.vault.setup.touchIdUnavailable"));
        }
        await client.vaultQuickUnlockEnable();
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: vaultRoot(serverId) }),
  });
  const toggleTouchId = useCallback((value: boolean) => setTouchId(value), []);
  return (
    <SettingAnchor id={enabled ? undefined : "vault.enabled"}>
      <View style={styles.stack} testID="vault-setup">
        <View style={styles.lead}>
          <Text style={settingsStyles.rowTitle}>{t("settings.vault.setup.title")}</Text>
          <Text style={settingsStyles.rowHint}>{t("settings.vault.setup.lead")}</Text>
        </View>
        <SettingsCard>
          <SecretInputForm
            label={t("settings.vault.passphrase")}
            confirmLabel={t("settings.vault.passphraseConfirm")}
            submitLabel={t("settings.vault.setup.submit")}
            minLength={VAULT_MIN_PASSPHRASE_LENGTH}
            pending={turnOn.isPending}
            error={turnOn.error ? vaultErrorMessage(turnOn.error) : null}
            onSubmit={turnOn.mutate}
            onEdit={turnOn.reset}
            testID="vault-create"
          >
            {canUseTouchId ? (
              <View style={styles.touchId}>
                <Switch
                  value={touchId}
                  onValueChange={toggleTouchId}
                  accessibilityLabel={t("settings.vault.setup.touchId")}
                  testID="vault-setup-touch-id"
                />
                <Text style={settingsStyles.rowTitle}>{t("settings.vault.setup.touchId")}</Text>
              </View>
            ) : null}
          </SecretInputForm>
        </SettingsCard>
        <Text style={settingsStyles.rowHint}>{t("settings.vault.setup.lossWarning")}</Text>
      </View>
    </SettingAnchor>
  );
}

const styles = StyleSheet.create((theme) => ({
  stack: { marginBottom: theme.spacing[6], gap: theme.spacing[3] },
  lead: { gap: theme.spacing[1] },
  touchId: { flexDirection: "row", alignItems: "center", gap: theme.spacing[3] },
}));
