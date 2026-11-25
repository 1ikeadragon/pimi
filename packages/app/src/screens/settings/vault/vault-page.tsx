import { useCallback, useEffect } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { VAULT_MIN_PASSPHRASE_LENGTH, type VaultStatus } from "@pimi/protocol/vault/types";
import { SettingsCard, SettingsRow } from "@/components/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useTranslation } from "@/i18n/use-translation";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { AuditSection } from "./audit-section";
import { BitwardenSection } from "./bitwarden-section";
import { EnvSection } from "./env-section";
import { GrantsSection } from "./grants-section";
import { RequestsSection } from "./requests-section";
import { SecretInputForm } from "./secret-input-form";
import { SecretsSection } from "./secrets-section";
import {
  useVaultAction,
  useVaultAudit,
  useVaultEnabled,
  useVaultEnabledSetting,
  useVaultEnvCandidates,
  useVaultGrants,
  useVaultRequests,
  useVaultSecrets,
  useVaultStatus,
  useVaultSync,
  vaultErrorMessage,
} from "./use-vault";

export function HostVaultPage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const connected = useHostRuntimeIsConnected(serverId);
  const enabled = useVaultEnabled(serverId);
  if (!connected) {
    return (
      <Alert
        size="md"
        variant="warning"
        title={t("settings.vault.offlineTitle")}
        description={t("settings.vault.offlineDescription")}
      />
    );
  }
  if (enabled === null) return <Alert size="sm" title={t("settings.vault.loading")} />;
  return (
    <View>
      <VaultEnabledSwitch serverId={serverId} enabled={enabled} />
      {enabled ? <EnabledVaultPage serverId={serverId} /> : null}
    </View>
  );
}

function VaultEnabledSwitch({ serverId, enabled }: { serverId: string; enabled: boolean }) {
  const { t } = useTranslation();
  const { error, pending, setEnabled } = useVaultEnabledSetting(serverId);
  return (
    <View style={styles.stack}>
      <SettingsCard>
        <SettingsRow
          label={t("settings.vault.enable")}
          hint={enabled ? t("settings.vault.enabledHint") : t("settings.vault.disabledHint")}
          error={error ? vaultErrorMessage(error) : undefined}
        >
          <Switch
            value={enabled}
            disabled={pending}
            onValueChange={setEnabled}
            accessibilityLabel={t("settings.vault.enable")}
            testID="vault-enabled-switch"
          />
        </SettingsRow>
      </SettingsCard>
    </View>
  );
}

function EnabledVaultPage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  useVaultSync(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const status = useVaultStatus(serverId);
  const { refetch } = status;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);

  if (!connected) {
    return (
      <Alert
        size="md"
        variant="warning"
        title={t("settings.vault.offlineTitle")}
        description={t("settings.vault.offlineDescription")}
      />
    );
  }
  if (status.isError) {
    return (
      <Alert size="sm" variant="error" title={vaultErrorMessage(status.error)}>
        <Button variant="outline" onPress={retry}>
          {t("settings.vault.retry")}
        </Button>
      </Alert>
    );
  }
  if (!status.data) return <Alert size="sm" title={t("settings.vault.loading")} />;
  if (status.data.state === "uninitialized") return <CreateVault serverId={serverId} />;
  if (status.data.state === "locked") return <UnlockVault serverId={serverId} />;
  return <UnlockedVault serverId={serverId} status={status.data} refetchStatus={retry} />;
}

function CreateVault({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const create = useVaultAction(serverId, (client, passphrase: string) =>
    client.vaultInitialize({ passphrase }),
  );
  return (
    <View style={styles.stack}>
      <Alert
        size="sm"
        title={t("settings.vault.create.title")}
        description={t("settings.vault.create.description")}
      />
      <SettingsCard>
        <SecretInputForm
          label={t("settings.vault.passphrase")}
          confirmLabel={t("settings.vault.passphraseConfirm")}
          submitLabel={t("settings.vault.create.submit")}
          minLength={VAULT_MIN_PASSPHRASE_LENGTH}
          pending={create.isPending}
          error={create.error ? vaultErrorMessage(create.error) : null}
          onSubmit={create.mutate}
          onEdit={create.reset}
          testID="vault-create"
        />
      </SettingsCard>
      <Text style={settingsStyles.rowHint}>
        {t("settings.vault.create.minimum", { count: VAULT_MIN_PASSPHRASE_LENGTH })}
      </Text>
    </View>
  );
}

function UnlockVault({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const unlock = useVaultAction(serverId, (client, passphrase: string) =>
    client.vaultUnlock({ passphrase }),
  );
  return (
    <View style={styles.stack}>
      <SettingsCard>
        <SecretInputForm
          label={t("settings.vault.passphrase")}
          submitLabel={t("settings.vault.unlock")}
          pending={unlock.isPending}
          error={unlock.error ? vaultErrorMessage(unlock.error) : null}
          onSubmit={unlock.mutate}
          onEdit={unlock.reset}
          testID="vault-unlock"
        />
      </SettingsCard>
    </View>
  );
}

/** Whether this connection is the operator, refetching the status when the mark runs out. */
function useOperator(operatorUntil: string | null, refetchStatus: () => void): boolean {
  const until = operatorUntil === null ? null : Date.parse(operatorUntil);
  useEffect(() => {
    if (until === null) return;
    const timer = setTimeout(refetchStatus, Math.max(0, until - Date.now()));
    return () => clearTimeout(timer);
  }, [refetchStatus, until]);
  return until !== null && until > Date.now();
}

function UnlockedVault({
  serverId,
  status,
  refetchStatus,
}: {
  serverId: string;
  status: VaultStatus;
  refetchStatus: () => void;
}) {
  const { t } = useTranslation();
  const operator = useOperator(status.operatorUntil, refetchStatus);
  const secrets = useVaultSecrets(serverId, true);
  const grants = useVaultGrants(serverId, true);
  const requests = useVaultRequests(serverId, true);
  const candidates = useVaultEnvCandidates(serverId, true);
  const audit = useVaultAudit(serverId, true);
  const lock = useVaultAction(serverId, (client, _input: null) => client.vaultLock());
  const authorize = useVaultAction(serverId, (client, passphrase: string) =>
    client.vaultAuthorize({ passphrase }),
  );
  const handleLock = useCallback(() => lock.mutate(null), [lock]);
  return (
    <View testID="vault-page">
      <SettingsSection title={t("settings.vault.statusTitle")} info={t("settings.vault.info")}>
        <SettingsCard>
          <SettingsRow
            label={t("settings.vault.unlockedTitle")}
            hint={
              status.idleLockAt
                ? t("settings.vault.locksAt", {
                    when: new Date(status.idleLockAt).toLocaleTimeString(),
                  })
                : undefined
            }
            error={lock.error ? vaultErrorMessage(lock.error) : undefined}
          >
            <Button variant="outline" onPress={handleLock} disabled={lock.isPending}>
              {t("settings.vault.lock")}
            </Button>
          </SettingsRow>
          {operator ? null : (
            <SecretInputForm
              label={t("settings.vault.authorizeLabel")}
              submitLabel={t("settings.vault.authorize")}
              pending={authorize.isPending}
              error={authorize.error ? vaultErrorMessage(authorize.error) : null}
              onSubmit={authorize.mutate}
              onEdit={authorize.reset}
              testID="vault-authorize"
            />
          )}
        </SettingsCard>
        {operator ? null : (
          <Text style={settingsStyles.rowHint}>{t("settings.vault.authorizeHint")}</Text>
        )}
      </SettingsSection>
      <RequestsSection serverId={serverId} requests={requests.data ?? []} operator={operator} />
      <SecretsSection serverId={serverId} secrets={secrets.data ?? []} operator={operator} />
      <GrantsSection serverId={serverId} grants={grants.data ?? []} operator={operator} />
      <EnvSection serverId={serverId} candidates={candidates.data ?? []} operator={operator} />
      <BitwardenSection serverId={serverId} operator={operator} />
      <AuditSection entries={audit.data ?? []} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  stack: { marginBottom: theme.spacing[6], gap: theme.spacing[3] },
}));
