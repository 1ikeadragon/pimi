import { useCallback, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react-native";
import { AGENT_PROVIDER_DEFINITIONS } from "@pimi/protocol/provider-manifest";
import type { ProviderOverride } from "@pimi/protocol/provider-config";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField } from "@/components/ui/select-field";
import { generateDraftId } from "@/stores/draft-keys";
import {
  buildCustomProvider,
  customProviderFields,
  defaultProviderId,
  PROVIDER_CONFIG_DIRECTORIES,
} from "./custom-provider-form";

const HARNESS_OPTIONS = [
  { id: "acp", value: "acp", label: "ACP" },
  ...AGENT_PROVIDER_DEFINITIONS.map(({ id, label }) => ({ id, value: id, label })),
];

interface EnvironmentEntry {
  id: string;
  name: string;
  value: string;
}

export function CustomProviderSheet({
  initial,
  onClose,
  onSave,
  onDiagnostics,
}: {
  initial?: { id: string; provider: ProviderOverride };
  onClose: () => void;
  onSave: (id: string, provider: ProviderOverride) => Promise<void>;
  onDiagnostics?: () => void;
}) {
  const { t } = useTranslation();
  const [fields] = useState(() => customProviderFields(initial?.provider));
  const [label, setLabel] = useState(initial?.provider.label ?? "");
  const [id, setId] = useState(initial?.id ?? "");
  const [harness, setHarness] = useState(initial?.provider.extends ?? "acp");
  const [binary, setBinary] = useState(fields.binary);
  const [args, setArgs] = useState(fields.args);
  const [advanced, setAdvanced] = useState(fields.advanced);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const configKey = PROVIDER_CONFIG_DIRECTORIES[harness];
  const [configDirectory, setConfigDirectory] = useState(initial?.provider.env?.[configKey] ?? "");
  const [environment, setEnvironment] = useState<EnvironmentEntry[]>(() =>
    Object.entries(initial?.provider.env ?? {})
      .filter(([name]) => name !== configKey)
      .map(([name, value]) => ({ id: name, name, value })),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const providerId = id.trim() || defaultProviderId(label);
  const providerLabel = label.trim();
  const harnessLabel = HARNESS_OPTIONS.find((option) => option.value === harness)?.label ?? harness;

  const addEnvironment = useCallback(() => {
    setEnvironment((current) => [...current, { id: generateDraftId(), name: "", value: "" }]);
  }, []);
  const changeEnvironment = useCallback(
    (entryId: string, field: "name" | "value", value: string) => {
      setEnvironment((current) =>
        current.map((entry) => (entry.id === entryId ? { ...entry, [field]: value } : entry)),
      );
    },
    [],
  );
  const removeEnvironment = useCallback((entryId: string) => {
    setEnvironment((current) => current.filter((entry) => entry.id !== entryId));
  }, []);
  const toggleAdvanced = useCallback(() => setShowAdvanced((current) => !current), []);
  const changeHarness = useCallback((value: string) => {
    setHarness(value);
    setConfigDirectory("");
  }, []);

  const save = useCallback(async () => {
    if (pending.current || !providerId || !providerLabel) return;
    setError(null);
    pending.current = true;
    setSaving(true);
    try {
      const provider = buildCustomProvider({
        id: providerId,
        label: providerLabel,
        harness,
        binary,
        args,
        advanced,
        configDirectory,
        environment,
      });
      await onSave(providerId, provider);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.providers.addErrorTitle"));
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }, [
    advanced,
    args,
    binary,
    configDirectory,
    environment,
    harness,
    onClose,
    onSave,
    providerId,
    providerLabel,
    t,
  ]);
  const close = useCallback(() => {
    if (!pending.current) onClose();
  }, [onClose]);
  const title = initial ? "Edit provider" : t("settings.providers.custom.title");
  const header = useMemo(() => ({ title }), [title]);
  const selectedHarness = useMemo(() => ({ label: harnessLabel }), [harnessLabel]);
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        {onDiagnostics ? (
          <Button variant="ghost" onPress={onDiagnostics} disabled={saving}>
            Diagnostics
          </Button>
        ) : null}
        <Button
          disabled={!providerId || !providerLabel || saving}
          loading={saving}
          onPress={save}
          testID="custom-provider-save"
        >
          {initial ? "Save provider" : t("settings.providers.addProvider")}
        </Button>
      </View>
    ),
    [initial, onDiagnostics, providerId, providerLabel, save, saving, t],
  );

  const runtimeFields = useMemo(
    () => (
      <>
        <Text style={styles.section}>Runtime</Text>
        <Field label="Binary path" hint="Executable name on this host, or its full path.">
          <FormTextInput
            initialValue={binary}
            onChangeText={setBinary}
            editable={!saving}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={harness === "acp" ? "my-agent" : harness}
            accessibilityLabel="Binary path"
            testID="custom-provider-binary"
          />
        </Field>
        <Field
          label="Launch arguments"
          hint={
            harness === "claude"
              ? "One --flag or --flag=value per line."
              : "One argument per line. Spaces within an argument are kept."
          }
        >
          <FormTextInput
            initialValue={args}
            onChangeText={setArgs}
            editable={!saving}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            style={styles.args}
            accessibilityLabel="Launch arguments"
            testID="custom-provider-args"
          />
        </Field>
        {configKey ? (
          <Field label="Config directory" hint={configKey}>
            <FormTextInput
              key={configKey}
              initialValue={configDirectory}
              onChangeText={setConfigDirectory}
              editable={!saving}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Config directory"
              testID="custom-provider-config-directory"
            />
          </Field>
        ) : null}
      </>
    ),
    [args, binary, configDirectory, configKey, harness, saving],
  );

  return (
    <AdaptiveModalSheet
      visible
      onClose={close}
      header={header}
      testID="custom-provider-sheet"
      footer={footer}
    >
      <View style={styles.form}>
        <Field label="Display name">
          <FormTextInput
            initialValue={label}
            onChangeText={setLabel}
            editable={!saving}
            accessibilityLabel="Display name"
            testID="custom-provider-name"
          />
        </Field>
        <SelectField
          label={t("settings.providers.custom.harness")}
          value={harness}
          selectedDisplay={selectedHarness}
          options={HARNESS_OPTIONS}
          onChange={changeHarness}
          placeholder={t("settings.providers.custom.harness")}
          emptyText={t("settings.providers.custom.harness")}
          searchable={false}
          disabled={saving || Boolean(initial)}
          triggerTestID="custom-provider-harness"
        />
        {runtimeFields}
        <View style={styles.environmentHeading}>
          <Text style={styles.section}>Environment</Text>
          <Button
            size="sm"
            variant="ghost"
            leftIcon={Plus}
            onPress={addEnvironment}
            disabled={saving}
            testID="custom-provider-add-env"
          >
            Add variable
          </Button>
        </View>
        {environment.map((entry) => (
          <EnvironmentRow
            key={entry.id}
            entry={entry}
            onChange={changeEnvironment}
            onRemove={removeEnvironment}
            saving={saving}
          />
        ))}
        <Button
          size="sm"
          variant="ghost"
          onPress={toggleAdvanced}
          testID="custom-provider-advanced"
        >
          {showAdvanced ? "Hide advanced settings" : "Advanced settings"}
        </Button>
        {showAdvanced ? (
          <>
            <Field
              label={t("settings.providers.custom.id")}
              hint={t("settings.providers.custom.idHint")}
            >
              <FormTextInput
                initialValue={id}
                placeholder={providerId}
                onChangeText={setId}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!saving && !initial}
                accessibilityLabel={t("settings.providers.custom.id")}
                testID="custom-provider-id"
              />
            </Field>
            <Field
              label={t("settings.providers.custom.settings")}
              hint="Provider options, models, and tool settings."
            >
              <FormTextInput
                initialValue={advanced}
                onChangeText={setAdvanced}
                autoCapitalize="none"
                autoCorrect={false}
                multiline
                style={styles.json}
                editable={!saving}
                accessibilityLabel={t("settings.providers.custom.settings")}
                testID="custom-provider-settings"
              />
            </Field>
          </>
        ) : null}
        {error ? (
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

function EnvironmentRow({
  entry,
  onChange,
  onRemove,
  saving,
}: {
  entry: EnvironmentEntry;
  onChange: (id: string, field: "name" | "value", value: string) => void;
  onRemove: (id: string) => void;
  saving: boolean;
}) {
  const changeName = useCallback(
    (value: string) => onChange(entry.id, "name", value),
    [entry.id, onChange],
  );
  const changeValue = useCallback(
    (value: string) => onChange(entry.id, "value", value),
    [entry.id, onChange],
  );
  const remove = useCallback(() => onRemove(entry.id), [entry.id, onRemove]);
  return (
    <View style={styles.environmentRow}>
      <FormTextInput
        initialValue={entry.name}
        onChangeText={changeName}
        editable={!saving}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="NAME"
        accessibilityLabel="Variable name"
        style={styles.environmentInput}
      />
      <FormTextInput
        initialValue={entry.value}
        onChangeText={changeValue}
        editable={!saving}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={/(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(entry.name)}
        placeholder="Value"
        accessibilityLabel="Variable value"
        style={styles.environmentInput}
      />
      <Button
        variant="ghost"
        size="sm"
        leftIcon={X}
        onPress={remove}
        disabled={saving}
        accessibilityLabel="Remove variable"
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  form: { gap: theme.spacing[3] },
  section: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  args: { minHeight: 54, textAlignVertical: "top" },
  json: { minHeight: 100, textAlignVertical: "top" },
  footer: { flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing[2] },
  environmentHeading: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  environmentRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  environmentInput: { flex: 1, minWidth: 0 },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
}));
