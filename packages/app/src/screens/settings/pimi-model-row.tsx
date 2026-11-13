import { useCallback, useMemo, type ReactElement, type ReactNode } from "react";
import { View } from "react-native";
import { useTranslation } from "@/i18n/use-translation";
import { StyleSheet } from "react-native-unistyles";
import type { AgentProvider } from "@pimi/protocol/agent-types";
import type { ProviderSnapshotEntry } from "@pimi/protocol/agent-types";
import { formatThinkingOptionLabel } from "@/agent-controls/labels";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import { SettingsRow } from "@/components/settings";
import { Button } from "@/components/ui/button";
import type { ControlSize } from "@/components/ui/control-geometry";
import { useContainedControlSize } from "@/components/ui/control-size";
import {
  SelectField,
  SelectFieldTrigger,
  type SelectFieldDisplay,
  type SelectFieldOption,
} from "@/components/ui/select-field";
import type { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { buildSelectableProviderSelectorProviders } from "@/provider-selection/provider-selection";

export interface PimiModelChoice {
  provider: string;
  model?: string;
  thinkingOptionId?: string;
}

interface PimiModelRowProps {
  label: string;
  hint?: string;
  serverId: string;
  snapshot: ReturnType<typeof useProvidersSnapshot>;
  value: PimiModelChoice | null;
  /** Shown while no model is chosen. */
  placeholder: string;
  onChange: (value: PimiModelChoice) => void;
  /** Clears the choice. The row offers Reset only when there is a choice and a handler. */
  onReset?: () => void;
  /** Limits the picker to these providers. */
  providerIds?: readonly string[];
  disabled?: boolean;
  testID: string;
}

type ProviderModel = NonNullable<ProviderSnapshotEntry["models"]>[number];

function findModel(
  entries: readonly ProviderSnapshotEntry[],
  value: PimiModelChoice | null,
): ProviderModel | null {
  if (!value?.model) {
    return null;
  }
  const entry = entries.find((candidate) => candidate.provider === value.provider);
  return entry?.models?.find((model) => model.id === value.model) ?? null;
}

function triggerLabelFor(
  entries: readonly ProviderSnapshotEntry[],
  value: PimiModelChoice | null,
  model: ProviderModel | null,
  placeholder: string,
): string {
  if (!value) {
    return placeholder;
  }
  const provider = entries.find((entry) => entry.provider === value.provider);
  return model?.label ?? value.model ?? provider?.label ?? value.provider;
}

export function PimiModelRow(props: PimiModelRowProps): ReactElement {
  const { t } = useTranslation();
  const { label, hint, snapshot, value } = props;
  const entry = value ? snapshot.entries?.find((item) => item.provider === value.provider) : null;
  const unavailable =
    value && !snapshot.isLoading && (!entry || !entry.enabled)
      ? t("settings.pimiModels.unavailable", { provider: entry?.label ?? value.provider })
      : undefined;
  return (
    <SettingsRow label={label} hint={hint} error={unavailable} testID={props.testID}>
      <PimiModelControls {...props} />
    </SettingsRow>
  );
}

function PimiModelControls({
  serverId,
  snapshot,
  value,
  placeholder,
  onChange,
  onReset,
  providerIds,
  disabled,
  testID,
}: PimiModelRowProps): ReactNode {
  const { t } = useTranslation();
  const size = useContainedControlSize() ?? "md";
  const entries = useMemo(() => snapshot.entries ?? [], [snapshot.entries]);
  const providers = useMemo(
    () =>
      buildSelectableProviderSelectorProviders(entries).filter(
        (provider) => !providerIds || providerIds.includes(provider.id),
      ),
    [entries, providerIds],
  );
  const model = findModel(entries, value);
  const triggerLabel = triggerLabelFor(entries, value, model, placeholder);

  const handleSelect = useCallback(
    (provider: AgentProvider, modelId: string) =>
      onChange({ provider, ...(modelId ? { model: modelId } : {}) }),
    [onChange],
  );
  const handleOpen = useCallback(
    () => snapshot.refetchIfStale(value?.provider),
    [snapshot, value?.provider],
  );
  const handleRetryProvider = useCallback(
    (provider: AgentProvider) => void snapshot.refresh([provider]),
    [snapshot],
  );
  const renderTrigger = useCallback(
    (input: { disabled: boolean; isOpen: boolean; hovered: boolean; pressed: boolean }) => (
      <SelectFieldTrigger
        label={triggerLabel}
        isPlaceholder={!value}
        placeholder={placeholder}
        disabled={input.disabled}
        active={input.hovered || input.pressed || input.isOpen}
        size={size}
        testID={`${testID}-model-trigger`}
      />
    ),
    [placeholder, size, testID, triggerLabel, value],
  );

  return (
    <View style={styles.controls}>
      <View style={styles.model}>
        <CombinedModelSelector
          providers={providers}
          selectedProvider={value?.provider ?? ""}
          selectedModel={value?.model ?? ""}
          onSelect={handleSelect}
          isLoading={snapshot.isLoading || snapshot.isFetching}
          renderTrigger={renderTrigger}
          triggerFill
          onOpen={handleOpen}
          onRetryProvider={handleRetryProvider}
          isRetryingProvider={snapshot.isRefreshing}
          disabled={disabled}
          serverId={serverId}
          desktopPlacement="bottom-start"
          desktopMinWidth={360}
        />
      </View>
      {value && model?.thinkingOptions?.length ? (
        <ThinkingSelect
          model={model}
          value={value}
          onChange={onChange}
          size={size}
          disabled={disabled}
          testID={testID}
        />
      ) : null}
      {value && onReset ? (
        <Button variant="ghost" onPress={onReset} disabled={disabled} testID={`${testID}-reset`}>
          {t("settings.pimiModels.reset")}
        </Button>
      ) : null}
    </View>
  );
}

function ThinkingSelect({
  model,
  value,
  onChange,
  size,
  disabled,
  testID,
}: {
  model: ProviderModel;
  value: PimiModelChoice;
  onChange: (value: PimiModelChoice) => void;
  size: ControlSize;
  disabled?: boolean;
  testID: string;
}): ReactElement {
  const { t } = useTranslation();
  const options = useMemo<SelectFieldOption<string>[]>(
    () =>
      (model.thinkingOptions ?? []).map((option) => ({
        id: option.id,
        value: option.id,
        label: formatThinkingOptionLabel(option),
        testID: `${testID}-thinking-option-${option.id}`,
      })),
    [model.thinkingOptions, testID],
  );
  const activeId = value.thinkingOptionId ?? model.defaultThinkingOptionId ?? null;
  const display = useMemo<SelectFieldDisplay | null>(() => {
    const option = options.find((candidate) => candidate.id === activeId);
    return option ? { label: option.label } : null;
  }, [activeId, options]);
  const handleChange = useCallback(
    (thinkingOptionId: string) => onChange({ ...value, thinkingOptionId }),
    [onChange, value],
  );
  return (
    <View style={styles.thinking}>
      <SelectField
        field={false}
        label={t("settings.pimiModels.thinking")}
        value={activeId}
        selectedDisplay={display}
        options={options}
        onChange={handleChange}
        placeholder={t("settings.pimiModels.thinking")}
        emptyText={t("settings.pimiModels.thinking")}
        searchable={false}
        title={t("settings.pimiModels.thinking")}
        size={size}
        disabled={disabled}
        triggerTestID={`${testID}-thinking-trigger`}
      />
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  controls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    flexWrap: "wrap",
    gap: 8,
  },
  model: {
    minWidth: 180,
    maxWidth: 260,
  },
  thinking: {
    minWidth: 110,
  },
}));
