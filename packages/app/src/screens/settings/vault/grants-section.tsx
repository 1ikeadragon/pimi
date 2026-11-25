import { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { VaultGrant } from "@pimi/protocol/vault/types";
import { SettingsCard, SettingsRow } from "@/components/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { useTranslation } from "@/i18n/use-translation";
import { settingsStyles } from "@/styles/settings";
import { useVaultAction, vaultErrorMessage } from "./use-vault";

interface GrantsSectionProps {
  serverId: string;
  grants: VaultGrant[];
  operator: boolean;
}

export function GrantsSection({ serverId, grants, operator }: GrantsSectionProps) {
  const { t } = useTranslation();
  const remove = useVaultAction(serverId, (client, grantId: string) =>
    client.vaultDeleteGrant({ grantId }),
  );
  return (
    <SettingsSection
      title={t("settings.vault.grants.title")}
      info={t("settings.vault.grants.info")}
    >
      {remove.error ? (
        <Alert size="sm" variant="error" title={vaultErrorMessage(remove.error)} />
      ) : null}
      <SettingsCard testID="vault-grants">
        {grants.length === 0 ? (
          <View style={styles.empty}>
            <Text style={settingsStyles.rowHint}>{t("settings.vault.grants.empty")}</Text>
          </View>
        ) : (
          grants.map((grant) => (
            <GrantRow
              key={grant.id}
              grant={grant}
              operator={operator}
              pending={remove.isPending}
              onRemove={remove.mutate}
            />
          ))
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

function GrantRow({
  grant,
  operator,
  pending,
  onRemove,
}: {
  grant: VaultGrant;
  operator: boolean;
  pending: boolean;
  onRemove: (grantId: string) => void;
}) {
  const { t } = useTranslation();
  const remove = useCallback(() => onRemove(grant.id), [grant.id, onRemove]);
  const command = [grant.executable, ...grant.argvPrefix].join(" ");
  const anyArguments = grant.argvPrefix.length === 0;
  const secrets = grant.bindings
    .map((binding) => `${binding.secret} → ${binding.envName}`)
    .join(", ");
  return (
    <SettingsRow
      label={command}
      hint={t("settings.vault.grants.detail", {
        secrets,
        scope: grant.projectId
          ? t("settings.vault.grants.oneProject")
          : t("settings.vault.grants.anyProject"),
      })}
      testID={`vault-grant-${grant.id}`}
    >
      <View style={styles.trailing}>
        {grant.runsProjectCode ? (
          <StatusBadge
            label={t("settings.vault.grants.runsProjectCode")}
            variant="warning"
            size="xs"
          />
        ) : null}
        {anyArguments ? (
          <StatusBadge
            label={t("settings.vault.grants.anyArguments")}
            variant="warning"
            size="xs"
          />
        ) : null}
        <Button variant="outline" onPress={remove} disabled={!operator || pending}>
          {t("settings.vault.grants.remove")}
        </Button>
      </View>
    </SettingsRow>
  );
}

const styles = StyleSheet.create((theme) => ({
  empty: {
    padding: theme.spacing[4],
  },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
}));
