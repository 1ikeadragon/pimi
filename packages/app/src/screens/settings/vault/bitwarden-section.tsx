import { useCallback, useReducer, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { VaultBitwardenItem, VaultBitwardenMissing } from "@pimi/protocol/vault/types";
import { SettingsCard, SettingsRow } from "@/components/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useTranslation } from "@/i18n/use-translation";
import { settingsStyles } from "@/styles/settings";
import { SecretInputForm } from "./secret-input-form";
import {
  secretNameIssues,
  useBitwardenStatus,
  useVaultAction,
  vaultErrorMessage,
} from "./use-vault";

interface BitwardenSectionProps {
  serverId: string;
  operator: boolean;
}

interface Binding {
  itemId: string;
  itemName: string;
  field: string;
}

export function BitwardenSection({ serverId, operator }: BitwardenSectionProps) {
  const { t } = useTranslation();
  const status = useBitwardenStatus(serverId, true);
  const unlock = useVaultAction(serverId, (client, masterPassword: string) =>
    client.vaultBitwardenUnlock({ masterPassword }),
  );
  const drop = useVaultAction(serverId, (client, _input: null) => client.vaultBitwardenLock());
  const dropValues = useCallback(() => drop.mutate(null), [drop]);
  const missing: VaultBitwardenMissing[] = status.data?.missing ?? [];
  const data = status.data;
  return (
    <SettingsSection
      title={t("settings.vault.bitwarden.title")}
      info={t("settings.vault.bitwarden.info")}
    >
      {data && !data.installed ? (
        <Alert size="sm" variant="info" title={t("settings.vault.bitwarden.notInstalled")} />
      ) : null}
      {data?.installed && data.authState === "unauthenticated" ? (
        <Alert size="sm" variant="warning" title={t("settings.vault.bitwarden.notLoggedIn")} />
      ) : null}
      {data?.installed ? (
        <>
          <SettingsCard testID="vault-bitwarden">
            <SettingsRow
              label={t("settings.vault.bitwarden.loadedTitle")}
              hint={
                data.loadedSecrets.length > 0 && data.loadedUntil
                  ? t("settings.vault.bitwarden.loadedUntil", {
                      count: data.loadedSecrets.length,
                      when: new Date(data.loadedUntil).toLocaleTimeString(),
                    })
                  : t("settings.vault.bitwarden.nothingLoaded")
              }
            >
              {data.loadedSecrets.length > 0 ? (
                <Button variant="outline" onPress={dropValues} disabled={drop.isPending}>
                  {t("settings.vault.bitwarden.drop")}
                </Button>
              ) : null}
            </SettingsRow>
            {operator ? (
              <SecretInputForm
                label={t("settings.vault.bitwarden.masterPassword")}
                submitLabel={t("settings.vault.bitwarden.load")}
                pending={unlock.isPending}
                error={unlock.error ? vaultErrorMessage(unlock.error) : null}
                onSubmit={unlock.mutate}
                testID="vault-bitwarden-unlock"
              />
            ) : (
              <View style={styles.pad}>
                <Text style={settingsStyles.rowHint}>
                  {t("settings.vault.bitwarden.needsOperator")}
                </Text>
              </View>
            )}
          </SettingsCard>
          {missing.length > 0 ? (
            <Alert
              size="sm"
              variant="warning"
              title={t("settings.vault.bitwarden.missing", {
                names: missing.map((entry) => `${entry.secret} (${entry.reason})`).join(", "),
              })}
            />
          ) : null}
          {operator ? <BitwardenBind serverId={serverId} /> : null}
        </>
      ) : null}
    </SettingsSection>
  );
}

interface SearchState {
  masterPassword: string;
  query: string;
  resetKey: number;
}

type SearchAction =
  | { type: "field"; field: "masterPassword" | "query"; value: string }
  | { type: "clearPassword" };

function searchReducer(state: SearchState, action: SearchAction): SearchState {
  if (action.type === "clearPassword") {
    return { ...state, masterPassword: "", resetKey: state.resetKey + 1 };
  }
  return { ...state, [action.field]: action.value };
}

function BitwardenBind({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const [state, dispatch] = useReducer(searchReducer, {
    masterPassword: "",
    query: "",
    resetKey: 0,
  });
  const [binding, setBinding] = useState<Binding | null>(null);
  const closeBinding = useCallback(() => setBinding(null), []);
  const search = useVaultAction(
    serverId,
    (client, input: { masterPassword: string; query: string }) =>
      client.vaultBitwardenSearchItems(input),
  );
  const setPassword = useCallback(
    (value: string) => dispatch({ type: "field", field: "masterPassword", value }),
    [],
  );
  const setQuery = useCallback(
    (value: string) => dispatch({ type: "field", field: "query", value }),
    [],
  );
  const canSearch = state.masterPassword.length > 0 && state.query.length > 0 && !search.isPending;
  const submit = useCallback(() => {
    if (!canSearch) return;
    search.mutate({ masterPassword: state.masterPassword, query: state.query });
    dispatch({ type: "clearPassword" });
  }, [canSearch, search, state.masterPassword, state.query]);
  return (
    <View style={[settingsStyles.card, styles.form]} testID="vault-bitwarden-search">
      <Text style={settingsStyles.rowTitle}>{t("settings.vault.bitwarden.bindTitle")}</Text>
      <Field label={t("settings.vault.bitwarden.queryLabel")}>
        <FormTextInput
          initialValue=""
          resetKey={state.resetKey}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={t("settings.vault.bitwarden.queryLabel")}
        />
      </Field>
      <Field label={t("settings.vault.bitwarden.masterPassword")}>
        <FormTextInput
          initialValue=""
          resetKey={state.resetKey}
          onChangeText={setPassword}
          onSubmitEditing={submit}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={t("settings.vault.bitwarden.masterPassword")}
        />
      </Field>
      {search.error ? (
        <Text accessibilityRole="alert" style={settingsStyles.rowError}>
          {vaultErrorMessage(search.error)}
        </Text>
      ) : null}
      <Button onPress={submit} disabled={!canSearch}>
        {search.isPending ? t("settings.vault.working") : t("settings.vault.bitwarden.search")}
      </Button>
      {(search.data?.items ?? []).map((item) => (
        <BitwardenItemRow key={item.id} item={item} onBind={setBinding} />
      ))}
      {binding ? <BindForm serverId={serverId} binding={binding} onDone={closeBinding} /> : null}
    </View>
  );
}

function BitwardenItemRow({
  item,
  onBind,
}: {
  item: VaultBitwardenItem;
  onBind: (binding: Binding) => void;
}) {
  return (
    <View style={styles.item}>
      <Text style={settingsStyles.rowTitle}>{item.name}</Text>
      <View style={styles.fields}>
        {item.fields.map((field) => (
          <BindButton key={field} item={item} field={field} onBind={onBind} />
        ))}
      </View>
    </View>
  );
}

function BindButton({
  item,
  field,
  onBind,
}: {
  item: VaultBitwardenItem;
  field: string;
  onBind: (binding: Binding) => void;
}) {
  const press = useCallback(
    () => onBind({ itemId: item.id, itemName: item.name, field }),
    [field, item.id, item.name, onBind],
  );
  return (
    <Button variant="outline" onPress={press}>
      {field}
    </Button>
  );
}

function BindForm({
  serverId,
  binding,
  onDone,
}: {
  serverId: string;
  binding: Binding;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [envName, setEnvName] = useState("");
  const create = useVaultAction(serverId, (client, input: { name: string; envName: string }) =>
    client.vaultSetSecret({
      name: input.name,
      envName: input.envName,
      description: `${binding.itemName} / ${binding.field}`,
      source: { kind: "bitwarden", itemId: binding.itemId, field: binding.field },
      value: null,
    }),
  );
  const { mutate } = create;
  const issues = secretNameIssues(name, envName);
  const submit = useCallback(() => {
    mutate({ name, envName }, { onSuccess: onDone });
  }, [envName, mutate, name, onDone]);
  return (
    <View style={styles.form}>
      <Text style={settingsStyles.rowHint}>
        {t("settings.vault.bitwarden.binding", { item: binding.itemName, field: binding.field })}
      </Text>
      <Field label={t("settings.vault.secrets.nameLabel")} error={issues.name}>
        <FormTextInput
          initialValue=""
          onChangeText={setName}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={t("settings.vault.secrets.nameLabel")}
        />
      </Field>
      <Field label={t("settings.vault.secrets.envLabel")} error={issues.envName}>
        <FormTextInput
          initialValue=""
          onChangeText={setEnvName}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={t("settings.vault.secrets.envLabel")}
        />
      </Field>
      {create.error ? (
        <Text accessibilityRole="alert" style={settingsStyles.rowError}>
          {vaultErrorMessage(create.error)}
        </Text>
      ) : null}
      <Button onPress={submit} disabled={!issues.valid || create.isPending}>
        {t("settings.vault.bitwarden.bind")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  pad: {
    padding: theme.spacing[4],
  },
  form: {
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  item: {
    gap: theme.spacing[2],
  },
  fields: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
}));
