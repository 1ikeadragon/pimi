import { useCallback, useReducer, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  secretNameFromEnvName,
  type VaultGrant,
  type VaultSecretMeta,
} from "@pimi/protocol/vault/types";
import { SettingsCard, SettingsRow } from "@/components/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { StatusBadge } from "@/components/ui/status-badge";
import { useTranslation } from "@/i18n/use-translation";
import { SettingAnchor } from "@/settings-index/anchor";
import { useSettingsFocusStore } from "@/settings-index/focus";
import { settingsStyles } from "@/styles/settings";
import { EnvPasteImport } from "./import/env-paste";
import { useRebindStore } from "./rebind-store";
import {
  secretNameIssues,
  useBitwardenStatus,
  useVaultAction,
  vaultErrorMessage,
} from "./use-vault";

// A value shorter than this is not registered with the output redactor (see docs/vault.md).
const MIN_REDACTABLE_LENGTH = 8;

interface SecretsSectionProps {
  serverId: string;
  secrets: VaultSecretMeta[];
  grants: VaultGrant[];
  operator: boolean;
}

type AddMode = "closed" | "typed" | "env";

export function SecretsSection({ serverId, secrets, grants, operator }: SecretsSectionProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<AddMode>("closed");
  const [added, setAdded] = useState(false);
  const hasBitwarden = secrets.some((secret) => secret.source.kind === "bitwarden");
  const bitwarden = useBitwardenStatus(serverId, hasBitwarden);
  const remove = useVaultAction(serverId, (client, name: string) =>
    client.vaultDeleteSecret({ name }),
  );
  const showTyped = useCallback(() => setMode("typed"), []);
  const showEnv = useCallback(() => setMode("env"), []);
  const closeAdd = useCallback(() => setMode("closed"), []);
  const showBitwarden = useCallback(
    () => useSettingsFocusStore.getState().focusSetting("vault.sources"),
    [],
  );
  const markAdded = useCallback(() => setAdded(true), []);
  const loaded = bitwarden.data?.loadedSecrets ?? [];
  const missing = bitwarden.data?.missing ?? [];
  return (
    <>
      <SettingAnchor id="vault.secrets">
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
                <Text style={settingsStyles.rowTitle}>{t("settings.vault.setup.addFirst")}</Text>
              </View>
            ) : (
              secrets.map((secret) => (
                <SecretRow
                  key={secret.name}
                  serverId={serverId}
                  secret={secret}
                  approved={grants.filter((grant) => grantUses(grant, secret.name)).length}
                  loaded={loaded.includes(secret.name)}
                  missing={missing.find((entry) => entry.secret === secret.name)?.reason ?? null}
                  operator={operator}
                  pending={remove.isPending}
                  onRemove={remove.mutate}
                />
              ))
            )}
          </SettingsCard>
          {added ? (
            <Text style={settingsStyles.rowHint}>{t("settings.vault.setup.newChats")}</Text>
          ) : null}
        </SettingsSection>
      </SettingAnchor>
      <SettingAnchor id="vault.import">
        <View style={styles.add}>
          <View style={styles.choices}>
            <Button
              variant={mode === "typed" ? "secondary" : "outline"}
              onPress={showTyped}
              testID="vault-add-typed"
            >
              {t("settings.vault.secrets.addTyped")}
            </Button>
            <Button
              variant={mode === "env" ? "secondary" : "outline"}
              onPress={showEnv}
              testID="vault-add-env"
            >
              {t("settings.vault.secrets.addEnv")}
            </Button>
            <Button variant="outline" onPress={showBitwarden} testID="vault-add-bitwarden">
              {t("settings.vault.secrets.addBitwarden")}
            </Button>
          </View>
          {mode === "typed" ? (
            <AddSecretForm
              serverId={serverId}
              operator={operator}
              onAdded={markAdded}
              onClose={closeAdd}
            />
          ) : null}
          {mode === "env" ? (
            <EnvPasteImport
              serverId={serverId}
              operator={operator}
              onAdded={markAdded}
              onClose={closeAdd}
            />
          ) : null}
        </View>
      </SettingAnchor>
    </>
  );
}

function grantUses(grant: VaultGrant, name: string): boolean {
  return grant.bindings.some((binding) => binding.secret === name);
}

type RowMode = "idle" | "replace" | "confirmRemove";

interface SecretRowProps {
  serverId: string;
  secret: VaultSecretMeta;
  approved: number;
  loaded: boolean;
  missing: "item_not_found" | "field_not_found" | null;
  operator: boolean;
  pending: boolean;
  onRemove: (name: string) => void;
}

function sourceDetail(secret: VaultSecretMeta): string | null {
  if (secret.source.kind !== "bitwarden") return null;
  return secret.description ?? secret.source.field;
}

function SecretRow({
  serverId,
  secret,
  approved,
  loaded,
  missing,
  operator,
  pending,
  onRemove,
}: SecretRowProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<RowMode>("idle");
  const startRebind = useRebindStore((state) => state.start);
  const isBitwarden = secret.source.kind === "bitwarden";
  const askRemove = useCallback(() => {
    if (approved > 0) setMode("confirmRemove");
    else onRemove(secret.name);
  }, [approved, onRemove, secret.name]);
  const confirmRemove = useCallback(() => onRemove(secret.name), [onRemove, secret.name]);
  const startReplace = useCallback(() => setMode("replace"), []);
  const backToIdle = useCallback(() => setMode("idle"), []);
  const rebind = useCallback(() => {
    startRebind({ name: secret.name, envName: secret.envName });
    useSettingsFocusStore.getState().focusSetting("vault.sources");
  }, [secret.envName, secret.name, startRebind]);
  const lastUsed = secret.lastUsedAt
    ? t("settings.vault.secrets.lastUsed", { when: new Date(secret.lastUsedAt).toLocaleString() })
    : t("settings.vault.secrets.neverUsed");
  const detail = sourceDetail(secret);
  const source =
    secret.source.kind === "local"
      ? t("settings.vault.secrets.sourceLocal")
      : t("settings.vault.secrets.sourceBitwarden", { detail });
  const reason = missing === null ? null : missingReason(missing, secret, t);
  return (
    <View testID={`vault-secret-${secret.name}`}>
      <SettingsRow label={secret.name} hint={`${secret.envName} · ${source} · ${lastUsed}`}>
        <View style={styles.trailing}>
          {isBitwarden && missing !== null ? (
            <StatusBadge label={t("settings.vault.secrets.missing")} variant="error" size="xs" />
          ) : null}
          {isBitwarden && missing === null && !loaded ? (
            <StatusBadge label={t("settings.vault.secrets.notLoaded")} variant="muted" size="xs" />
          ) : null}
          {!isBitwarden && !secret.redactable ? (
            <StatusBadge
              label={t("settings.vault.secrets.notRedacted")}
              variant="warning"
              size="xs"
            />
          ) : null}
          {isBitwarden && missing !== null ? (
            <Button variant="outline" onPress={rebind} disabled={!operator}>
              {t("settings.vault.secrets.rebind")}
            </Button>
          ) : null}
          {isBitwarden ? null : (
            <Button
              variant="outline"
              onPress={startReplace}
              disabled={!operator || mode !== "idle"}
            >
              {t("settings.vault.secrets.replace")}
            </Button>
          )}
          <Button
            variant="outline"
            onPress={askRemove}
            disabled={!operator || pending || mode === "confirmRemove"}
          >
            {t("settings.vault.secrets.remove")}
          </Button>
        </View>
      </SettingsRow>
      {reason ? (
        <View style={styles.inline}>
          <Text style={settingsStyles.rowError}>{reason}</Text>
        </View>
      ) : null}
      {mode === "replace" ? (
        <ReplaceValueForm serverId={serverId} secret={secret} onDone={backToIdle} />
      ) : null}
      {mode === "confirmRemove" ? (
        <View style={styles.inline}>
          <Text style={settingsStyles.rowHint}>
            {t("settings.vault.secrets.removeConfirm", { name: secret.name, count: approved })}
          </Text>
          <View style={styles.trailing}>
            <Button variant="outline" onPress={backToIdle}>
              {t("settings.vault.secrets.keep")}
            </Button>
            <Button onPress={confirmRemove} disabled={pending}>
              {t("settings.vault.secrets.remove")}
            </Button>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function missingReason(
  reason: "item_not_found" | "field_not_found",
  secret: VaultSecretMeta,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (reason === "item_not_found") return t("settings.vault.bitwarden.itemGone");
  const field = secret.source.kind === "bitwarden" ? secret.source.field : "";
  return t("settings.vault.bitwarden.fieldGone", { field });
}

function ReplaceValueForm({
  serverId,
  secret,
  onDone,
}: {
  serverId: string;
  secret: VaultSecretMeta;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const replace = useVaultAction(serverId, (client, next: string) =>
    client.vaultSetSecret({
      name: secret.name,
      envName: secret.envName,
      description: secret.description,
      source: secret.source,
      value: next,
    }),
  );
  const { mutate } = replace;
  const submit = useCallback(() => {
    if (value.length > 0) mutate(value, { onSuccess: onDone });
  }, [mutate, onDone, value]);
  return (
    <View style={styles.inline}>
      <Field label={t("settings.vault.secrets.valueLabel")}>
        <FormTextInput
          initialValue=""
          onChangeText={setValue}
          onSubmitEditing={submit}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={t("settings.vault.secrets.valueLabel")}
          testID="vault-replace-value"
        />
      </Field>
      {value.length > 0 && value.length < MIN_REDACTABLE_LENGTH ? (
        <Text style={settingsStyles.rowHint}>{t("settings.vault.secrets.tooShort")}</Text>
      ) : null}
      {replace.error ? (
        <Text accessibilityRole="alert" style={settingsStyles.rowError}>
          {vaultErrorMessage(replace.error)}
        </Text>
      ) : null}
      <View style={styles.trailing}>
        <Button variant="outline" onPress={onDone}>
          {t("settings.vault.secrets.cancel")}
        </Button>
        <Button
          onPress={submit}
          disabled={value.length === 0 || replace.isPending}
          testID="vault-replace-submit"
        >
          {t("settings.vault.secrets.replaceSubmit")}
        </Button>
      </View>
    </View>
  );
}

interface AddState {
  envName: string;
  value: string;
  nameOverride: string | null;
  description: string;
  editing: boolean;
  resetKey: number;
}

type AddAction =
  | { type: "envName" | "value" | "description" | "nameOverride"; value: string }
  | { type: "edit" }
  | { type: "clear" };

const EMPTY_ADD: AddState = {
  envName: "",
  value: "",
  nameOverride: null,
  description: "",
  editing: false,
  resetKey: 0,
};

function addReducer(state: AddState, action: AddAction): AddState {
  switch (action.type) {
    case "clear":
      return { ...EMPTY_ADD, resetKey: state.resetKey + 1 };
    case "edit":
      return { ...state, editing: true };
    default:
      return { ...state, [action.type]: action.value };
  }
}

interface AddSecretFormProps {
  serverId: string;
  operator: boolean;
  onAdded: () => void;
  onClose: () => void;
}

function AddSecretForm({ serverId, operator, onAdded, onClose }: AddSecretFormProps) {
  const { t } = useTranslation();
  const [state, dispatch] = useReducer(addReducer, EMPTY_ADD);
  const add = useVaultAction(
    serverId,
    (client, input: { name: string; envName: string; description: string | null; value: string }) =>
      client.vaultSetSecret({
        ...input,
        source: { kind: "local" },
      }),
  );
  const name = state.nameOverride ?? secretNameFromEnvName(state.envName);
  const issues = secretNameIssues(name, state.envName);
  const canSubmit = operator && issues.valid && state.value.length > 0 && !add.isPending;
  const setEnvName = useCallback((value: string) => dispatch({ type: "envName", value }), []);
  const setValue = useCallback((value: string) => dispatch({ type: "value", value }), []);
  const setName = useCallback((value: string) => dispatch({ type: "nameOverride", value }), []);
  const setDescription = useCallback(
    (value: string) => dispatch({ type: "description", value }),
    [],
  );
  const edit = useCallback(() => dispatch({ type: "edit" }), []);
  const submit = useCallback(() => {
    if (!canSubmit) return;
    // The fields stay until the daemon accepts the secret, so a failed add is not retyped.
    add.mutate(
      {
        name,
        envName: state.envName,
        description: state.description.length > 0 ? state.description : null,
        value: state.value,
      },
      {
        onSuccess: () => {
          dispatch({ type: "clear" });
          onAdded();
          onClose();
        },
      },
    );
  }, [add, canSubmit, name, onAdded, onClose, state.description, state.envName, state.value]);
  const tooShort = state.value.length > 0 && state.value.length < MIN_REDACTABLE_LENGTH;
  return (
    <View style={[settingsStyles.card, styles.form]} testID="vault-add-secret">
      <Field label={t("settings.vault.secrets.variableLabel")} error={issues.envName}>
        <FormTextInput
          initialValue=""
          resetKey={state.resetKey}
          onChangeText={setEnvName}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t("settings.vault.secrets.variablePlaceholder")}
          accessibilityLabel={t("settings.vault.secrets.variableLabel")}
          testID="vault-add-secret-env"
        />
      </Field>
      <Field label={t("settings.vault.secrets.valueLabel")}>
        <FormTextInput
          initialValue=""
          resetKey={state.resetKey}
          onChangeText={setValue}
          onSubmitEditing={submit}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={t("settings.vault.secrets.valueLabel")}
          testID="vault-add-secret-value"
        />
      </Field>
      {tooShort ? (
        <Text style={settingsStyles.rowHint} testID="vault-add-secret-short">
          {t("settings.vault.secrets.tooShort")}
        </Text>
      ) : null}
      {state.editing ? (
        <>
          <Field label={t("settings.vault.secrets.nameLabel")} error={issues.name}>
            <FormTextInput
              initialValue={name}
              onChangeText={setName}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel={t("settings.vault.secrets.nameLabel")}
              testID="vault-add-secret-name"
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
        </>
      ) : (
        <View style={styles.trailing}>
          <Text style={settingsStyles.rowHint} testID="vault-add-secret-name-seen">
            {t("settings.vault.secrets.nameSeen", { name: name || "-" })}
          </Text>
          <Button size="sm" variant="ghost" onPress={edit} testID="vault-add-secret-edit">
            {t("settings.vault.secrets.editName")}
          </Button>
        </View>
      )}
      {add.error ? (
        <Text accessibilityRole="alert" style={settingsStyles.rowError}>
          {vaultErrorMessage(add.error)}
        </Text>
      ) : null}
      <View style={styles.trailing}>
        <Button variant="outline" onPress={onClose}>
          {t("settings.vault.secrets.cancel")}
        </Button>
        <Button onPress={submit} disabled={!canSubmit} testID="vault-add-secret-submit">
          {add.isPending ? t("settings.vault.working") : t("settings.vault.secrets.add")}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  empty: {
    padding: theme.spacing[4],
  },
  add: {
    gap: theme.spacing[3],
    marginBottom: theme.spacing[6],
  },
  choices: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  inline: {
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
  form: {
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
}));
