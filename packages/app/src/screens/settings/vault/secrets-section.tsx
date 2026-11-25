import { useCallback, useReducer } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { VaultSecretMeta, VaultSecretSource } from "@pimi/protocol/vault/types";
import { SettingsCard, SettingsRow } from "@/components/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { StatusBadge } from "@/components/ui/status-badge";
import { useTranslation } from "@/i18n/use-translation";
import { settingsStyles } from "@/styles/settings";
import { secretNameIssues, useVaultAction, vaultErrorMessage } from "./use-vault";

interface SecretsSectionProps {
  serverId: string;
  secrets: VaultSecretMeta[];
  operator: boolean;
}

interface SetSecretInput {
  name: string;
  envName: string;
  description: string | null;
  source: VaultSecretSource;
  value: string | null;
}

function sourceLabel(source: VaultSecretSource, t: (key: string) => string): string {
  return source.kind === "local"
    ? t("settings.vault.secrets.sourceLocal")
    : t("settings.vault.secrets.sourceBitwarden");
}

export function SecretsSection({ serverId, secrets, operator }: SecretsSectionProps) {
  const { t } = useTranslation();
  const remove = useVaultAction(serverId, (client, name: string) =>
    client.vaultDeleteSecret({ name }),
  );
  const handleRemove = remove.mutate;
  return (
    <SettingsSection
      title={t("settings.vault.secrets.title")}
      info={t("settings.vault.secrets.info")}
    >
      {remove.error ? (
        <Alert size="sm" variant="error" title={vaultErrorMessage(remove.error)} />
      ) : null}
      <SettingsCard testID="vault-secrets">
        {secrets.length === 0 ? (
          <View style={styles.empty}>
            <Text style={settingsStyles.rowHint}>{t("settings.vault.secrets.empty")}</Text>
          </View>
        ) : (
          secrets.map((secret) => (
            <SecretRow
              key={secret.name}
              secret={secret}
              operator={operator}
              pending={remove.isPending}
              onRemove={handleRemove}
            />
          ))
        )}
      </SettingsCard>
      <AddSecretForm serverId={serverId} operator={operator} />
    </SettingsSection>
  );
}

function SecretRow({
  secret,
  operator,
  pending,
  onRemove,
}: {
  secret: VaultSecretMeta;
  operator: boolean;
  pending: boolean;
  onRemove: (name: string) => void;
}) {
  const { t } = useTranslation();
  const remove = useCallback(() => onRemove(secret.name), [onRemove, secret.name]);
  const lastUsed = secret.lastUsedAt
    ? t("settings.vault.secrets.lastUsed", { when: new Date(secret.lastUsedAt).toLocaleString() })
    : t("settings.vault.secrets.neverUsed");
  return (
    <SettingsRow
      label={secret.name}
      hint={`${secret.envName} · ${sourceLabel(secret.source, t)} · ${lastUsed}`}
      testID={`vault-secret-${secret.name}`}
    >
      <View style={styles.trailing}>
        {secret.redactable ? null : (
          <StatusBadge
            label={t("settings.vault.secrets.notRedacted")}
            variant="warning"
            size="xs"
          />
        )}
        <Button variant="outline" onPress={remove} disabled={!operator || pending}>
          {t("settings.vault.secrets.remove")}
        </Button>
      </View>
    </SettingsRow>
  );
}

interface AddState {
  name: string;
  envName: string;
  description: string;
  value: string;
  resetKey: number;
}

type AddAction =
  | { type: "field"; field: "name" | "envName" | "description" | "value"; value: string }
  | { type: "clear" };

function addReducer(state: AddState, action: AddAction): AddState {
  if (action.type === "clear") {
    return { name: "", envName: "", description: "", value: "", resetKey: state.resetKey + 1 };
  }
  return { ...state, [action.field]: action.value };
}

function AddSecretForm({ serverId, operator }: { serverId: string; operator: boolean }) {
  const { t } = useTranslation();
  const [state, dispatch] = useReducer(addReducer, {
    name: "",
    envName: "",
    description: "",
    value: "",
    resetKey: 0,
  });
  const add = useVaultAction(serverId, (client, input: SetSecretInput) =>
    client.vaultSetSecret(input),
  );
  const issues = secretNameIssues(state.name, state.envName);
  const canSubmit = operator && issues.valid && state.value.length > 0 && !add.isPending;
  const setName = useCallback(
    (value: string) => dispatch({ type: "field", field: "name", value }),
    [],
  );
  const setEnvName = useCallback(
    (value: string) => dispatch({ type: "field", field: "envName", value }),
    [],
  );
  const setDescription = useCallback(
    (value: string) => dispatch({ type: "field", field: "description", value }),
    [],
  );
  const setValue = useCallback(
    (value: string) => dispatch({ type: "field", field: "value", value }),
    [],
  );
  const submit = useCallback(() => {
    if (!canSubmit) return;
    // The fields stay until the daemon accepts the secret, so a failed add is not retyped.
    add.mutate(
      {
        name: state.name,
        envName: state.envName,
        description: state.description.length > 0 ? state.description : null,
        source: { kind: "local" },
        value: state.value,
      },
      { onSuccess: () => dispatch({ type: "clear" }) },
    );
  }, [add, canSubmit, state]);
  return (
    <View style={[settingsStyles.card, styles.form]} testID="vault-add-secret">
      <Field label={t("settings.vault.secrets.nameLabel")} error={issues.name}>
        <FormTextInput
          initialValue=""
          resetKey={state.resetKey}
          onChangeText={setName}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t("settings.vault.secrets.namePlaceholder")}
          accessibilityLabel={t("settings.vault.secrets.nameLabel")}
          testID="vault-add-secret-name"
        />
      </Field>
      <Field label={t("settings.vault.secrets.envLabel")} error={issues.envName}>
        <FormTextInput
          initialValue=""
          resetKey={state.resetKey}
          onChangeText={setEnvName}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t("settings.vault.secrets.envPlaceholder")}
          accessibilityLabel={t("settings.vault.secrets.envLabel")}
          testID="vault-add-secret-env"
        />
      </Field>
      <Field label={t("settings.vault.secrets.descriptionLabel")}>
        <FormTextInput
          initialValue=""
          resetKey={state.resetKey}
          onChangeText={setDescription}
          accessibilityLabel={t("settings.vault.secrets.descriptionLabel")}
          testID="vault-add-secret-description"
        />
      </Field>
      <Field label={t("settings.vault.secrets.valueLabel")}>
        <FormTextInput
          initialValue=""
          resetKey={state.resetKey}
          onChangeText={setValue}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={t("settings.vault.secrets.valueLabel")}
          testID="vault-add-secret-value"
        />
      </Field>
      {add.error ? (
        <Text accessibilityRole="alert" style={settingsStyles.rowError}>
          {vaultErrorMessage(add.error)}
        </Text>
      ) : null}
      <Button onPress={submit} disabled={!canSubmit} testID="vault-add-secret-submit">
        {add.isPending ? t("settings.vault.working") : t("settings.vault.secrets.add")}
      </Button>
    </View>
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
  },
  form: {
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
}));
