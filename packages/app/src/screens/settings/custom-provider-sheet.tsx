import { useCallback, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AGENT_PROVIDER_DEFINITIONS } from "@pimi/protocol/provider-manifest";
import {
  ProviderOverrideSchema,
  ProviderOverridesSchema,
  type ProviderOverride,
} from "@pimi/protocol/provider-config";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField } from "@/components/ui/select-field";

const HARNESS_OPTIONS = [
  { id: "acp", value: "acp", label: "ACP" },
  ...AGENT_PROVIDER_DEFINITIONS.map(({ id, label }) => ({ id, value: id, label })),
];
const CUSTOM_SETTINGS = ProviderOverrideSchema.omit({ extends: true, label: true }).strict();

export function CustomProviderSheet({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (id: string, provider: ProviderOverride) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [label, setLabel] = useState("");
  const [id, setId] = useState("");
  const [harness, setHarness] = useState("acp");
  const [settings, setSettings] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const providerId = id.trim();
  const providerLabel = label.trim();
  const harnessLabel = HARNESS_OPTIONS.find((option) => option.value === harness)?.label ?? harness;

  const addProvider = useCallback(async () => {
    if (pending.current || !providerId || !providerLabel) return;
    setError(null);
    let raw: unknown;
    try {
      raw = JSON.parse(settings.trim() || "{}");
    } catch {
      setError(t("settings.providers.custom.invalidJson"));
      return;
    }
    const options = CUSTOM_SETTINGS.safeParse(raw);
    if (!options.success) {
      setError(t("settings.providers.custom.invalidSettings"));
      return;
    }
    const parsed = ProviderOverridesSchema.safeParse({
      [providerId]: { ...options.data, label: providerLabel, extends: harness },
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? t("settings.providers.custom.invalidSettings"));
      return;
    }
    pending.current = true;
    setSaving(true);
    try {
      await onAdd(providerId, parsed.data[providerId]);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.providers.addErrorTitle"));
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }, [harness, onAdd, onClose, providerId, providerLabel, settings, t]);
  const close = useCallback(() => {
    if (!pending.current) onClose();
  }, [onClose]);
  const header = useMemo(() => ({ title: t("settings.providers.custom.title") }), [t]);
  const selectedHarness = useMemo(() => ({ label: harnessLabel }), [harnessLabel]);
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button
          disabled={!providerId || !providerLabel || saving}
          loading={saving}
          onPress={addProvider}
          testID="custom-provider-save"
        >
          {t("settings.providers.addProvider")}
        </Button>
      </View>
    ),
    [addProvider, providerId, providerLabel, saving, t],
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
        <Field label={t("settings.providers.custom.name")}>
          <FormTextInput
            onChangeText={setLabel}
            editable={!saving}
            accessibilityLabel={t("settings.providers.custom.name")}
            testID="custom-provider-name"
          />
        </Field>
        <Field
          label={t("settings.providers.custom.id")}
          hint={t("settings.providers.custom.idHint")}
        >
          <FormTextInput
            onChangeText={setId}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!saving}
            accessibilityLabel={t("settings.providers.custom.id")}
            testID="custom-provider-id"
          />
        </Field>
        <SelectField
          label={t("settings.providers.custom.harness")}
          value={harness}
          selectedDisplay={selectedHarness}
          options={HARNESS_OPTIONS}
          onChange={setHarness}
          placeholder={t("settings.providers.custom.harness")}
          emptyText={t("settings.providers.custom.harness")}
          searchable={false}
          disabled={saving}
          triggerTestID="custom-provider-harness"
        />
        <Field
          label={t("settings.providers.custom.settings")}
          hint={t(
            harness === "acp"
              ? "settings.providers.custom.acpHint"
              : "settings.providers.custom.profileHint",
          )}
        >
          <FormTextInput
            onChangeText={setSettings}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            style={styles.json}
            editable={!saving}
            placeholder={harness === "acp" ? '{"command": ["my-agent", "--acp"]}' : "{}"}
            accessibilityLabel={t("settings.providers.custom.settings")}
            testID="custom-provider-settings"
          />
        </Field>
        {error ? (
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  form: { gap: theme.spacing[4] },
  json: { minHeight: 100, textAlignVertical: "top" },
  footer: { flexDirection: "row", justifyContent: "flex-end" },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
}));
