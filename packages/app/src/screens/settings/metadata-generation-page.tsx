import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, View } from "react-native";
import { useTranslation } from "@/i18n/use-translation";
import { StyleSheet } from "react-native-unistyles";
import type { MutableDaemonConfigPatch, PimiModelFeature } from "@pimi/protocol/messages";
import { SettingsCard, SettingsRow } from "@/components/settings";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { PimiModelRow, type PimiModelChoice } from "@/screens/settings/pimi-model-row";

const METADATA_GENERATION_DOCS_URL =
  "https://github.com/1ikeadragon/pimi/blob/main/public-docs/metadata-generation.md";
type SelectionMode = "automatic" | "preferred";

// Ask Pimi drives a harness with its own tools, so only these providers can run it.
const ASK_PIMI_PROVIDER_IDS = ["claude", "codex", "opencode"] as const;

const FEATURE_ROWS: readonly PimiModelFeature[] = [
  "title",
  "branchName",
  "commitMessage",
  "pullRequest",
  "automation",
  "askPimi",
];

export function MetadataGenerationPage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const { config, isLoading: isConfigLoading, patchConfig } = useDaemonConfig(serverId);
  const snapshot = useProvidersSnapshot(serverId);
  const configuredProviders = config?.metadataGeneration.providers;
  const configuredProvider = configuredProviders?.[0] ?? null;
  const savedMode: SelectionMode = configuredProvider ? "preferred" : "automatic";
  const [draftMode, setDraftMode] = useState<SelectionMode | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const mode = draftMode ?? savedMode;

  useEffect(() => {
    setDraftMode(null);
  }, [configuredProvider?.model, configuredProvider?.provider]);

  const modeOptions = useMemo(
    () => [
      { value: "automatic" as const, label: t("settings.metadataGeneration.automatic") },
      { value: "preferred" as const, label: t("settings.metadataGeneration.preferred") },
    ],
    [t],
  );

  const save = useCallback(
    async (patch: NonNullable<MutableDaemonConfigPatch["metadataGeneration"]>) => {
      setIsSaving(true);
      try {
        await patchConfig({ metadataGeneration: patch });
      } catch (error) {
        setDraftMode(null);
        Alert.alert(
          t("settings.metadataGeneration.saveError"),
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        setIsSaving(false);
      }
    },
    [patchConfig, t],
  );

  const handleModeChange = useCallback(
    (next: SelectionMode) => {
      setDraftMode(next);
      if (next === "automatic") {
        void save({ providers: [] });
      }
    },
    [save],
  );

  const handleDefaultChange = useCallback(
    (choice: PimiModelChoice) => {
      setDraftMode("preferred");
      void save({ providers: [toPatchEntry(choice), ...(configuredProviders?.slice(1) ?? [])] });
    },
    [configuredProviders, save],
  );

  const handleAutoNaming = useCallback((autoNaming: boolean) => void save({ autoNaming }), [save]);

  const docsLink = useMemo(
    () => ({ href: METADATA_GENERATION_DOCS_URL, label: t("settings.metadataGeneration.docs") }),
    [t],
  );

  if (isConfigLoading || !config) {
    return (
      <View style={styles.loading}>
        <LoadingSpinner size="large" color={styles.spinnerColor.color} />
      </View>
    );
  }

  return (
    <>
      <SettingsSection
        title={t("settings.metadataGeneration.title")}
        info={t("settings.metadataGeneration.description")}
        link={docsLink}
        testID="metadata-generation-settings"
      >
        <SettingsCard>
          <SettingsRow
            label={t("settings.metadataGeneration.selection")}
            hint={
              mode === "automatic"
                ? t("settings.metadataGeneration.automaticHint")
                : t("settings.metadataGeneration.preferredHint")
            }
          >
            <SegmentedControl
              options={modeOptions}
              value={mode}
              onValueChange={handleModeChange}
              testID="metadata-generation-mode"
            />
          </SettingsRow>
          {mode === "preferred" ? (
            <PimiModelRow
              label={t("settings.metadataGeneration.model")}
              hint={t("settings.metadataGeneration.modelHint")}
              serverId={serverId}
              snapshot={snapshot}
              value={configuredProvider}
              placeholder={t("settings.pimiModels.selectModel")}
              onChange={handleDefaultChange}
              disabled={isSaving}
              testID="pimi-model-default"
            />
          ) : null}
          {typeof config.metadataGeneration.autoNaming === "boolean" ? (
            <SettingsRow
              label={t("settings.metadataGeneration.autoNaming")}
              hint={t("settings.metadataGeneration.autoNamingHint")}
            >
              <Switch
                value={config.metadataGeneration.autoNaming}
                disabled={isSaving}
                onValueChange={handleAutoNaming}
                accessibilityLabel={t("settings.metadataGeneration.autoNaming")}
                testID="metadata-generation-auto-naming"
              />
            </SettingsRow>
          ) : null}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection
        title={t("settings.pimiModels.perFeature")}
        info={t("settings.pimiModels.perFeatureInfo")}
        testID="pimi-models-per-feature"
      >
        <SettingsCard>
          {FEATURE_ROWS.map((feature) => (
            <FeatureRow
              key={feature}
              feature={feature}
              serverId={serverId}
              snapshot={snapshot}
              value={config.metadataGeneration.features?.[feature] ?? null}
              disabled={isSaving}
              onSave={save}
            />
          ))}
        </SettingsCard>
      </SettingsSection>
    </>
  );
}

// A plain object literal, so it fits the wire schema's open object type.
function toPatchEntry(choice: PimiModelChoice) {
  return {
    provider: choice.provider,
    ...(choice.model ? { model: choice.model } : {}),
    ...(choice.thinkingOptionId ? { thinkingOptionId: choice.thinkingOptionId } : {}),
  };
}

function FeatureRow({
  feature,
  serverId,
  snapshot,
  value,
  disabled,
  onSave,
}: {
  feature: PimiModelFeature;
  serverId: string;
  snapshot: ReturnType<typeof useProvidersSnapshot>;
  value: PimiModelChoice | null;
  disabled: boolean;
  onSave: (patch: NonNullable<MutableDaemonConfigPatch["metadataGeneration"]>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const handleChange = useCallback(
    (choice: PimiModelChoice) => void onSave({ features: { [feature]: toPatchEntry(choice) } }),
    [feature, onSave],
  );
  const handleReset = useCallback(
    () => void onSave({ features: { [feature]: null } }),
    [feature, onSave],
  );
  return (
    <PimiModelRow
      label={t(`settings.pimiModels.features.${feature}`)}
      serverId={serverId}
      snapshot={snapshot}
      value={value}
      placeholder={t("settings.pimiModels.sameAsDefault")}
      onChange={handleChange}
      onReset={handleReset}
      providerIds={feature === "askPimi" ? ASK_PIMI_PROVIDER_IDS : undefined}
      disabled={disabled}
      testID={`pimi-model-${feature}`}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  loading: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 180,
  },
  spinnerColor: {
    color: theme.colors.foregroundMuted,
  },
}));
