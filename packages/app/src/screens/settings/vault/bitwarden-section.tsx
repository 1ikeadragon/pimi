import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { StyleSheet } from "react-native-unistyles";
import {
  secretNameFromEnvName,
  type VaultBitwardenItem,
  type VaultBitwardenStatus,
} from "@pimi/protocol/vault/types";
import { SettingsCard } from "@/components/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useFetchQuery } from "@/data/query";
import { useAppSettings } from "@/hooks/use-settings";
import { useTranslation } from "@/i18n/use-translation";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { useRebindStore } from "./rebind-store";
import { SecretInputForm } from "./secret-input-form";
import { envNameFromParts } from "./secret-names";
import {
  secretNameIssues,
  useBitwardenStatus,
  useVaultAction,
  vaultErrorMessage,
  vaultRoot,
} from "./use-vault";

// A pause this long after the last keystroke sends one search to the index.
const SEARCH_DEBOUNCE_MS = 150;

interface BitwardenSectionProps {
  serverId: string;
  operator: boolean;
}

export function BitwardenSection({ serverId, operator }: BitwardenSectionProps) {
  const { t } = useTranslation();
  const status = useBitwardenStatus(serverId, true);
  const refresh = useVaultAction(serverId, (client, _input: null) =>
    client.vaultBitwardenRefresh(),
  );
  const checkAgain = useCallback(() => refresh.mutate(null), [refresh]);
  const rebind = useRebindStore((state) => state.target);
  const cancelRebind = useRebindStore((state) => state.clear);
  const [query, setQuery] = useState("");
  const data = status.data;
  return (
    <SettingsSection
      title={t("settings.vault.bitwarden.title")}
      info={t("settings.vault.bitwarden.info")}
    >
      {rebind ? (
        <Alert
          size="sm"
          variant="info"
          title={t("settings.vault.bitwarden.rebinding", { name: rebind.name })}
        >
          <Button variant="outline" onPress={cancelRebind}>
            {t("settings.vault.bitwarden.cancelRebind")}
          </Button>
        </Alert>
      ) : null}
      {data && !data.installed ? (
        <CommandCard
          title={t("settings.vault.bitwarden.notInstalled")}
          command="brew install bitwarden-cli"
          pending={refresh.isPending}
          onCheckAgain={checkAgain}
          testID="vault-bitwarden-missing"
        />
      ) : null}
      {data?.installed && data.authState === "unauthenticated" ? (
        <CommandCard
          title={t("settings.vault.bitwarden.signedOut")}
          command="bw login"
          pending={refresh.isPending}
          onCheckAgain={checkAgain}
          testID="vault-bitwarden-signed-out"
        />
      ) : null}
      {data?.installed && data.authState !== "unauthenticated" ? (
        <BitwardenAccount
          serverId={serverId}
          data={data}
          operator={operator}
          query={query}
          onQuery={setQuery}
        />
      ) : null}
    </SettingsSection>
  );
}

function CommandCard({
  title,
  command,
  pending,
  onCheckAgain,
  testID,
}: {
  title: string;
  command: string;
  pending: boolean;
  onCheckAgain: () => void;
  testID: string;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void Clipboard.setStringAsync(command).then(() => setCopied(true));
  }, [command]);
  return (
    <SettingsCard testID={testID}>
      <View style={styles.pad}>
        <Text style={settingsStyles.rowTitle}>{title}</Text>
        <Text style={styles.command} selectable>
          {command}
        </Text>
        <View style={styles.actions}>
          <Button variant="outline" onPress={copy} testID={`${testID}-copy`}>
            {copied ? t("settings.vault.bitwarden.copied") : t("settings.vault.bitwarden.copy")}
          </Button>
          <Button
            variant="outline"
            onPress={onCheckAgain}
            disabled={pending}
            testID={`${testID}-check`}
          >
            {t("settings.vault.bitwarden.checkAgain")}
          </Button>
        </View>
      </View>
    </SettingsCard>
  );
}

interface BitwardenAccountProps {
  serverId: string;
  data: VaultBitwardenStatus;
  operator: boolean;
  query: string;
  onQuery: (query: string) => void;
}

function BitwardenAccount({ serverId, data, operator, query, onQuery }: BitwardenAccountProps) {
  const { t } = useTranslation();
  const { settings } = useAppSettings();
  const synced = data.lastSyncAt
    ? new Date(data.lastSyncAt).toLocaleString()
    : t("settings.vault.bitwarden.never");
  const account =
    data.userEmail && !settings.streamerMode
      ? t("settings.vault.bitwarden.account", { email: data.userEmail, when: synced })
      : t("settings.vault.bitwarden.accountHidden", { when: synced });
  const open = data.indexedItems !== null;
  return (
    <>
      <SettingsCard testID="vault-bitwarden">
        <View style={styles.pad}>
          <Text style={settingsStyles.rowHint}>{account}</Text>
          {open ? (
            <OpenState serverId={serverId} data={data} />
          ) : (
            <LockedState serverId={serverId} operator={operator} />
          )}
        </View>
      </SettingsCard>
      {open && data.synced === false ? (
        <Alert
          size="sm"
          variant="warning"
          title={t("settings.vault.bitwarden.syncFailed", { when: synced })}
        />
      ) : null}
      {open && operator ? (
        <BitwardenPicker serverId={serverId} query={query} onQuery={onQuery} />
      ) : null}
    </>
  );
}

function LockedState({ serverId, operator }: { serverId: string; operator: boolean }) {
  const { t } = useTranslation();
  const unlock = useVaultAction(serverId, (client, masterPassword: string) =>
    client.vaultBitwardenUnlock({ masterPassword }),
  );
  if (!operator) {
    return (
      <Text style={settingsStyles.rowHint}>{t("settings.vault.bitwarden.needsOperator")}</Text>
    );
  }
  return (
    <>
      <SecretInputForm
        label={t("settings.vault.bitwarden.masterPassword")}
        submitLabel={t("settings.vault.bitwarden.unlock")}
        pending={unlock.isPending}
        error={unlock.error ? vaultErrorMessage(unlock.error) : null}
        onSubmit={unlock.mutate}
        onEdit={unlock.reset}
        testID="vault-bitwarden-unlock"
      />
      <Text style={settingsStyles.rowHint}>{t("settings.vault.bitwarden.unlockHint")}</Text>
    </>
  );
}

function OpenState({ serverId, data }: { serverId: string; data: VaultBitwardenStatus }) {
  const { t } = useTranslation();
  const drop = useVaultAction(serverId, (client, _input: null) => client.vaultBitwardenLock());
  const dropNow = useCallback(() => drop.mutate(null), [drop]);
  const until = data.loadedUntil ? new Date(data.loadedUntil).toLocaleTimeString() : "";
  return (
    <View style={styles.actions}>
      <Text style={settingsStyles.rowTitle} testID="vault-bitwarden-open">
        {t("settings.vault.bitwarden.open", { count: data.indexedItems ?? 0, when: until })}
      </Text>
      <Button
        variant="outline"
        onPress={dropNow}
        disabled={drop.isPending}
        testID="vault-bitwarden-drop"
      >
        {t("settings.vault.bitwarden.dropNow")}
      </Button>
    </View>
  );
}

function useDebounced(value: string): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value]);
  return debounced;
}

interface FieldChoice {
  item: VaultBitwardenItem;
  field: string;
}

function BitwardenPicker({
  serverId,
  query,
  onQuery,
}: {
  serverId: string;
  query: string;
  onQuery: (query: string) => void;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const [choice, setChoice] = useState<FieldChoice | null>(null);
  const pause = useDebounced(query.trim());
  const results = useFetchQuery({
    queryKey: [...vaultRoot(serverId), "bitwarden-search", pause],
    enabled: pause.length > 0 && client !== null,
    dataShape: "list",
    staleTimeMs: 30_000,
    queryFn: async () => {
      if (!client) throw new Error(t("settings.vault.offlineTitle"));
      return (await client.vaultBitwardenSearchItems({ query: pause })).items;
    },
  });
  const clearChoice = useCallback(() => setChoice(null), []);
  const items = pause.length > 0 ? (results.data ?? []) : [];
  return (
    <View style={[settingsStyles.card, styles.pad]} testID="vault-bitwarden-search">
      <Field label={t("settings.vault.bitwarden.searchLabel")}>
        <FormTextInput
          initialValue={query}
          onChangeText={onQuery}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t("settings.vault.bitwarden.searchPlaceholder")}
          accessibilityLabel={t("settings.vault.bitwarden.searchLabel")}
          testID="vault-bitwarden-query"
        />
      </Field>
      {results.error ? (
        <Text accessibilityRole="alert" style={settingsStyles.rowError}>
          {vaultErrorMessage(results.error)}
        </Text>
      ) : null}
      {pause.length > 0 && results.isSuccess && items.length === 0 ? (
        <Text style={settingsStyles.rowHint}>{t("settings.vault.bitwarden.noMatches")}</Text>
      ) : null}
      {items.map((item) => (
        <BitwardenItemRow key={item.id} item={item} onChoose={setChoice} />
      ))}
      {choice ? (
        <BitwardenAddForm
          key={`${choice.item.id}:${choice.field}`}
          serverId={serverId}
          choice={choice}
          onDone={clearChoice}
        />
      ) : null}
    </View>
  );
}

function BitwardenItemRow({
  item,
  onChoose,
}: {
  item: VaultBitwardenItem;
  onChoose: (choice: FieldChoice) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  return (
    <View style={styles.item}>
      <Button variant="ghost" onPress={toggle} testID={`vault-bitwarden-item-${item.id}`}>
        {item.username ? `${item.name} - ${item.username}` : item.name}
      </Button>
      {expanded ? (
        <View style={styles.actions}>
          {item.fields.map((field) => (
            <FieldButton key={field} item={item} field={field} onChoose={onChoose} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function FieldButton({
  item,
  field,
  onChoose,
}: {
  item: VaultBitwardenItem;
  field: string;
  onChoose: (choice: FieldChoice) => void;
}) {
  const press = useCallback(() => onChoose({ item, field }), [field, item, onChoose]);
  return (
    <Button variant="outline" onPress={press} testID={`vault-bitwarden-field-${field}`}>
      {field}
    </Button>
  );
}

/** The picked field as a secret, prefilled; one press adds it. A rebind keeps the secret's name. */
function BitwardenAddForm({
  serverId,
  choice,
  onDone,
}: {
  serverId: string;
  choice: FieldChoice;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const rebind = useRebindStore((state) => state.target);
  const clearRebind = useRebindStore((state) => state.clear);
  const [envName, setEnvName] = useState(
    rebind?.envName ?? envNameFromParts(choice.item.name, choice.field),
  );
  const name = rebind?.name ?? secretNameFromEnvName(envName);
  const issues = secretNameIssues(name, envName);
  const create = useVaultAction(serverId, (client, _input: null) =>
    client.vaultSetSecret({
      name,
      envName,
      description: `${choice.item.name} / ${choice.field}`,
      source: { kind: "bitwarden", itemId: choice.item.id, field: choice.field },
      value: null,
    }),
  );
  const { mutate } = create;
  const submit = useCallback(() => {
    mutate(null, {
      onSuccess: () => {
        clearRebind();
        onDone();
      },
    });
  }, [clearRebind, mutate, onDone]);
  return (
    <View style={styles.pad} testID="vault-bitwarden-add">
      <Text style={settingsStyles.rowTitle}>
        {rebind
          ? t("settings.vault.bitwarden.rebindTitle", {
              name: rebind.name,
              item: choice.item.name,
              field: choice.field,
            })
          : t("settings.vault.bitwarden.addTitle", {
              item: choice.item.name,
              field: choice.field,
            })}
      </Text>
      <Field label={t("settings.vault.secrets.variableLabel")} error={issues.envName}>
        <FormTextInput
          initialValue={envName}
          onChangeText={setEnvName}
          editable={!rebind}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={t("settings.vault.secrets.variableLabel")}
          testID="vault-bitwarden-add-env"
        />
      </Field>
      <Text style={settingsStyles.rowHint}>{t("settings.vault.secrets.nameSeen", { name })}</Text>
      {create.error ? (
        <Text accessibilityRole="alert" style={settingsStyles.rowError}>
          {vaultErrorMessage(create.error)}
        </Text>
      ) : null}
      <Button
        onPress={submit}
        disabled={!issues.valid || create.isPending}
        testID="vault-bitwarden-add-submit"
      >
        {t("settings.vault.secrets.add")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  pad: {
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  command: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  item: {
    gap: theme.spacing[2],
    alignItems: "flex-start",
  },
}));
