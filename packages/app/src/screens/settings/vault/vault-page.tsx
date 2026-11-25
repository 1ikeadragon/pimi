import { useCallback, useEffect } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { VaultStatus } from "@pimi/protocol/vault/types";
import { SettingsCard, SettingsRow } from "@/components/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n/use-translation";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { SettingAnchor } from "@/settings-index/anchor";
import { settingsStyles } from "@/styles/settings";
import { AuditSection } from "./audit-section";
import { BitwardenSection } from "./bitwarden-section";
import { AppleSection } from "./apple-passwords-section";
import { EnvSection } from "./env-section";
import { GrantsSection } from "./grants-section";
import { RequestsSection } from "./requests-section";
import { SecretInputForm } from "./secret-input-form";
import { SecretsSection } from "./secrets-section";
import { SetupCard } from "./setup-card";
import { UnlockingSection } from "./unlocking-section";
import {
  useCanUseTouchId,
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
  if (!enabled) {
    return (
      <View>
        <SetupCard serverId={serverId} enabled={false} />
        <VaultPreview />
      </View>
    );
  }
  return <EnabledVaultPage serverId={serverId} />;
}

const PREVIEW_PARTS = [
  "requests",
  "secrets",
  "import",
  "grants",
  "sources",
  "unlocking",
  "env",
  "audit",
] as const;

/**
 * What the live page holds, as plain rows, whenever the live sections cannot show: off, not set
 * up, or locked. The same ids mark the live sections, so search lands on the page either way.
 */
function VaultPreview() {
  const { t } = useTranslation();
  return (
    <SettingsSection title={t("settings.vault.preview.title")}>
      <SettingsCard testID="vault-preview">
        {PREVIEW_PARTS.map((part) => (
          <SettingsRow
            key={part}
            settingId={`vault.${part}`}
            label={t(`settings.vault.${part}.title`)}
            hint={t(`settings.vault.preview.${part}`)}
          />
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}

function TurnOffRow({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const { error, pending, setEnabled } = useVaultEnabledSetting(serverId);
  const turnOff = useCallback(() => setEnabled(false), [setEnabled]);
  return (
    <SettingsSection title={t("settings.vault.enable")}>
      <SettingsCard>
        <SettingsRow
          settingId="vault.enabled"
          label={t("settings.vault.turnOff")}
          hint={t("settings.vault.enabledHint")}
          error={error ? vaultErrorMessage(error) : undefined}
        >
          <Button
            variant="outline"
            onPress={turnOff}
            disabled={pending}
            testID="vault-enabled-switch"
          >
            {t("settings.vault.turnOff")}
          </Button>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}

function EnabledVaultPage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  useVaultSync(serverId);
  const status = useVaultStatus(serverId);
  const { refetch } = status;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);

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
  if (status.data.state === "uninitialized") {
    return (
      <>
        <SetupCard serverId={serverId} enabled />
        <VaultPreview />
        <TurnOffRow serverId={serverId} />
      </>
    );
  }
  if (status.data.state === "locked") {
    return (
      <>
        <UnlockVault serverId={serverId} status={status.data} />
        <VaultPreview />
        <TurnOffRow serverId={serverId} />
      </>
    );
  }
  return <UnlockedVault serverId={serverId} status={status.data} refetchStatus={retry} />;
}

function UnlockVault({ serverId, status }: { serverId: string; status: VaultStatus }) {
  const { t } = useTranslation();
  const canUseTouchId = useCanUseTouchId(serverId);
  const unlock = useVaultAction(serverId, (client, passphrase: string) =>
    client.vaultUnlock({ passphrase }),
  );
  const touch = useVaultAction(serverId, (client, _input: null) =>
    client.vaultQuickUnlockProve({ purpose: "unlock" }),
  );
  const unlockWithTouchId = useCallback(() => touch.mutate(null), [touch]);
  const error = unlock.error ?? touch.error;
  return (
    <View style={styles.stack}>
      <SettingsCard>
        {canUseTouchId && status.quickUnlock === "on" ? (
          <View style={styles.touchIdRow}>
            <Button onPress={unlockWithTouchId} disabled={touch.isPending} testID="vault-touch-id">
              {t("settings.vault.unlockWithTouchId")}
            </Button>
          </View>
        ) : null}
        <SecretInputForm
          label={t("settings.vault.passphrase")}
          submitLabel={t("settings.vault.unlock")}
          pending={unlock.isPending}
          error={error ? vaultErrorMessage(error) : null}
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

function AuthorizeBar({ serverId, status }: { serverId: string; status: VaultStatus }) {
  const { t } = useTranslation();
  const canUseTouchId = useCanUseTouchId(serverId);
  const authorize = useVaultAction(serverId, (client, passphrase: string) =>
    client.vaultAuthorize({ passphrase }),
  );
  const touch = useVaultAction(serverId, (client, _input: null) =>
    client.vaultQuickUnlockProve({ purpose: "authorize" }),
  );
  const authorizeWithTouchId = useCallback(() => touch.mutate(null), [touch]);
  const error = authorize.error ?? touch.error;
  return (
    <View style={styles.stack}>
      <SettingsCard>
        {canUseTouchId && status.quickUnlock === "on" ? (
          <View style={styles.touchIdRow}>
            <Button
              onPress={authorizeWithTouchId}
              disabled={touch.isPending}
              testID="vault-touch-id"
            >
              {t("settings.vault.authorizeWithTouchId")}
            </Button>
          </View>
        ) : null}
        <SecretInputForm
          label={t("settings.vault.authorizeLabel")}
          submitLabel={t("settings.vault.authorize")}
          pending={authorize.isPending}
          error={error ? vaultErrorMessage(error) : null}
          onSubmit={authorize.mutate}
          onEdit={authorize.reset}
          testID="vault-authorize"
        />
      </SettingsCard>
      <Text style={settingsStyles.rowHint}>{t("settings.vault.authorizeHint")}</Text>
    </View>
  );
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
  const operator = useOperator(status.operatorUntil, refetchStatus);
  const secrets = useVaultSecrets(serverId, true);
  const grants = useVaultGrants(serverId, true);
  const requests = useVaultRequests(serverId, true);
  const candidates = useVaultEnvCandidates(serverId, true);
  const audit = useVaultAudit(serverId, true);
  return (
    <View testID="vault-page">
      {operator ? null : <AuthorizeBar serverId={serverId} status={status} />}
      <SettingAnchor id="vault.requests">
        <RequestsSection serverId={serverId} requests={requests.data ?? []} />
      </SettingAnchor>
      <SecretsSection
        serverId={serverId}
        secrets={secrets.data ?? []}
        grants={grants.data ?? []}
        operator={operator}
      />
      <SettingAnchor id="vault.grants">
        <GrantsSection serverId={serverId} grants={grants.data ?? []} operator={operator} />
      </SettingAnchor>
      <SettingAnchor id="vault.sources">
        <BitwardenSection serverId={serverId} operator={operator} />
        <AppleSection serverId={serverId} operator={operator} />
      </SettingAnchor>
      <SettingAnchor id="vault.unlocking">
        <UnlockingSection serverId={serverId} status={status} operator={operator} />
      </SettingAnchor>
      <SettingAnchor id="vault.env">
        <EnvSection serverId={serverId} candidates={candidates.data ?? []} operator={operator} />
      </SettingAnchor>
      <SettingAnchor id="vault.audit">
        <AuditSection entries={audit.data ?? []} />
      </SettingAnchor>
      <TurnOffRow serverId={serverId} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  stack: { marginBottom: theme.spacing[6], gap: theme.spacing[3] },
  touchIdRow: { padding: theme.spacing[4], paddingBottom: 0 },
}));
