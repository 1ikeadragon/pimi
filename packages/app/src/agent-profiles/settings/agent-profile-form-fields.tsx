import { useCallback, useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "@/i18n/use-translation";
import { StyleSheet } from "react-native-unistyles";
import type { AgentFeature } from "@pimi/protocol/agent-types";
import { type ControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import {
  SelectField,
  type SelectFieldDisplay,
  type SelectFieldOption,
} from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import { AgentProfileAppearanceField } from "./agent-profile-appearance-field";
import type {
  AgentProfileFormModel,
  AgentProfileFormOption,
  AgentProfileFormState,
} from "../internal/profile-form-model";

/**
 * Only reachable before the catalog lands. Every select is seeded to a concrete
 * id as soon as one exists, and none of them offer an "unset" row.
 */
const UNSET_VALUE = "";
/** The provider select's "Any provider" row; the form model stores it as "". */
const ANY_PROVIDER_VALUE = "__any__";

export interface AgentProfileFormInitialText {
  name: string;
  notes: string;
  instructions: string;
}

export interface AgentProfileFormFieldsProps {
  model: AgentProfileFormModel;
  state: AgentProfileFormState;
  initialText: AgentProfileFormInitialText;
  /** "columns" puts name and launch setup on the left, instructions and notes on the right. */
  layout: "stacked" | "columns";
  size?: ControlSize;
}

function toSelectOptions(options: AgentProfileFormOption[]): SelectFieldOption<string>[] {
  return options.map((option) => ({
    id: option.id,
    value: option.value,
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
    testID: option.testID,
  }));
}

/** The profile form's inputs, shared by the quick-edit sheet and the profile page. */
export function AgentProfileFormFields({
  model,
  state,
  initialText,
  layout,
  size = "md",
}: AgentProfileFormFieldsProps): ReactElement {
  const { t } = useTranslation();

  const providerOptions = useMemo<SelectFieldOption<string>[]>(
    () => [
      {
        id: ANY_PROVIDER_VALUE,
        value: ANY_PROVIDER_VALUE,
        label: t("profiles.anyProvider"),
        description: t("profiles.anyProviderDescription"),
        testID: "agent-profile-provider-option-any",
      },
      ...toSelectOptions(state.providerOptions),
    ],
    [state.providerOptions, t],
  );
  const modelOptions = useMemo(() => toSelectOptions(state.modelOptions), [state.modelOptions]);
  const modeOptions = useMemo(() => toSelectOptions(state.modeOptions), [state.modeOptions]);
  const thinkingOptions = useMemo(
    () => toSelectOptions(state.thinkingOptions),
    [state.thinkingOptions],
  );
  const providerDisplay = useMemo<SelectFieldDisplay | null>(
    () => (state.provider ? state.providerDisplay : { label: t("profiles.anyProvider") }),
    [state.provider, state.providerDisplay, t],
  );

  const handleAppearanceChange = useCallback(
    (value: { icon: string; color: string }) => model.setAppearance(value),
    [model],
  );
  const handleProviderChange = useCallback(
    (value: string, display: SelectFieldDisplay) =>
      model.setProvider(value === ANY_PROVIDER_VALUE ? "" : value, display),
    [model],
  );
  const handleModelChange = useCallback(
    (value: string, display: SelectFieldDisplay) => model.setModel(value, value ? display : null),
    [model],
  );
  const handleModeChange = useCallback(
    (value: string, display: SelectFieldDisplay) => model.setMode(value, value ? display : null),
    [model],
  );
  const handleThinkingChange = useCallback(
    (value: string, display: SelectFieldDisplay) =>
      model.setThinking(value, value ? display : null),
    [model],
  );

  const disabled = state.isSubmitting;

  const nameRow = (
    <View style={styles.nameRow}>
      <View style={styles.iconField}>
        <AgentProfileAppearanceField
          label={t("settings.host.agentProfiles.iconLabel")}
          icon={state.icon}
          color={state.color}
          onChange={handleAppearanceChange}
          disabled={disabled}
          size={size}
          testID="agent-profile-icon-field"
          triggerTestID="agent-profile-icon-trigger"
        />
      </View>
      <View style={styles.nameField}>
        <Field label={t("settings.host.agentProfiles.nameLabel")} testID="agent-profile-name-field">
          <FormTextInput
            initialValue={initialText.name}
            onChangeText={model.setName}
            placeholder={t("settings.host.agentProfiles.namePlaceholder")}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!disabled}
            size={size}
            accessibilityLabel={t("settings.host.agentProfiles.nameLabel")}
            testID="agent-profile-name-input"
          />
        </Field>
      </View>
    </View>
  );

  const notesField = (
    <Field
      label={t("settings.host.agentProfiles.notesLabel")}
      hint={t("settings.host.agentProfiles.notesHint")}
      testID="agent-profile-notes-field"
    >
      <FormTextInput
        initialValue={initialText.notes}
        onChangeText={model.setNotes}
        placeholder={t("settings.host.agentProfiles.notesPlaceholder")}
        multiline
        numberOfLines={3}
        style={styles.notesInput}
        editable={!disabled}
        size={size}
        accessibilityLabel={t("settings.host.agentProfiles.notesLabel")}
        testID="agent-profile-notes-input"
      />
    </Field>
  );

  const instructionsField = (
    <Field
      label={t("profiles.instructionsLabel")}
      hint={t("profiles.instructionsHint")}
      testID="agent-profile-instructions-field"
    >
      <FormTextInput
        initialValue={initialText.instructions}
        onChangeText={model.setInstructions}
        placeholder={t("profiles.instructionsPlaceholder")}
        multiline
        numberOfLines={layout === "columns" ? 16 : 8}
        style={layout === "columns" ? styles.instructionsInputTall : styles.instructionsInput}
        editable={!disabled}
        size={size}
        accessibilityLabel={t("profiles.instructionsLabel")}
        testID="agent-profile-instructions-input"
      />
    </Field>
  );

  const launchSetup = (
    <>
      <SelectField
        label={t("settings.host.agentProfiles.providerLabel")}
        value={state.provider || ANY_PROVIDER_VALUE}
        selectedDisplay={providerDisplay}
        options={providerOptions}
        onChange={handleProviderChange}
        placeholder={t("settings.host.agentProfiles.providerPlaceholder")}
        emptyText={t("settings.host.agentProfiles.noProviders")}
        loading={state.catalogResolution !== "complete"}
        disabled={disabled}
        searchable={providerOptions.length > 6}
        title={t("settings.host.agentProfiles.providerLabel")}
        size={size}
        testID="agent-profile-provider-field"
        triggerTestID="agent-profile-provider-trigger"
      />

      {state.disclosure.showModelField ? (
        <SelectField
          label={t("settings.host.agentProfiles.modelLabel")}
          value={state.modelId || UNSET_VALUE}
          selectedDisplay={state.modelDisplay}
          options={modelOptions}
          onChange={handleModelChange}
          placeholder={t("settings.host.agentProfiles.modelLabel")}
          emptyText={t("settings.host.agentProfiles.noModels")}
          disabled={disabled}
          searchable={modelOptions.length > 6}
          title={t("settings.host.agentProfiles.modelLabel")}
          size={size}
          testID="agent-profile-model-field"
          triggerTestID="agent-profile-model-trigger"
        />
      ) : null}

      {state.disclosure.showModeField ? (
        <SelectField
          label={t("settings.host.agentProfiles.modeLabel")}
          value={state.modeId || UNSET_VALUE}
          selectedDisplay={state.modeDisplay}
          options={modeOptions}
          onChange={handleModeChange}
          placeholder={t("settings.host.agentProfiles.modeLabel")}
          emptyText={t("settings.host.agentProfiles.noModes")}
          disabled={disabled}
          searchable={modeOptions.length > 6}
          title={t("settings.host.agentProfiles.modeLabel")}
          size={size}
          testID="agent-profile-mode-field"
          triggerTestID="agent-profile-mode-trigger"
        />
      ) : null}

      {state.disclosure.showThinkingField ? (
        <SelectField
          label={t("settings.host.agentProfiles.thinkingLabel")}
          value={state.thinkingOptionId || UNSET_VALUE}
          selectedDisplay={state.thinkingDisplay}
          options={thinkingOptions}
          onChange={handleThinkingChange}
          placeholder={t("settings.host.agentProfiles.thinkingLabel")}
          emptyText={t("settings.host.agentProfiles.noThinkingOptions")}
          disabled={disabled}
          searchable={thinkingOptions.length > 6}
          title={t("settings.host.agentProfiles.thinkingLabel")}
          size={size}
          testID="agent-profile-thinking-field"
          triggerTestID="agent-profile-thinking-trigger"
        />
      ) : null}

      {state.disclosure.showFeaturesField ? (
        <Field
          label={t("settings.host.agentProfiles.featuresLabel")}
          testID="agent-profile-features-field"
        >
          <View style={styles.featureCard} testID="agent-profile-features-card">
            {state.features.map((feature, index) => (
              <AgentProfileFeatureRow
                key={feature.id}
                feature={feature}
                isFirst={index === 0}
                disabled={disabled}
                size={size}
                model={model}
              />
            ))}
          </View>
        </Field>
      ) : null}
    </>
  );

  if (layout === "columns") {
    return (
      <View style={styles.columns}>
        <View style={styles.setupColumn}>
          {nameRow}
          {launchSetup}
        </View>
        <View style={styles.instructionsColumn}>
          {instructionsField}
          {notesField}
        </View>
      </View>
    );
  }
  return (
    <View style={styles.stack}>
      {nameRow}
      {launchSetup}
      {instructionsField}
      {notesField}
    </View>
  );
}

function AgentProfileFeatureRow({
  feature,
  isFirst,
  disabled,
  size,
  model,
}: {
  feature: AgentFeature;
  isFirst: boolean;
  disabled: boolean;
  size: ControlSize;
  model: AgentProfileFormModel;
}): ReactElement {
  const rowStyle = useMemo(
    () => [styles.featureRow, isFirst ? null : styles.featureRowBorder],
    [isFirst],
  );
  const handleToggle = useCallback(
    (value: boolean) => model.setFeatureValue(feature.id, value),
    [feature.id, model],
  );
  const handleSelect = useCallback(
    (value: string) => model.setFeatureValue(feature.id, value),
    [feature.id, model],
  );
  const selectOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      feature.type === "select"
        ? feature.options.map((option) => ({
            id: option.id,
            value: option.id,
            label: option.label,
            ...(option.description ? { description: option.description } : {}),
            testID: `agent-profile-feature-option-${feature.id}-${option.id}`,
          }))
        : [],
    [feature],
  );
  const selectedDisplay = useMemo<SelectFieldDisplay | null>(() => {
    if (feature.type !== "select" || !feature.value) {
      return null;
    }
    const option = feature.options.find((candidate) => candidate.id === feature.value);
    return { label: option?.label ?? feature.value };
  }, [feature]);

  if (feature.type === "select") {
    return (
      <View style={rowStyle} testID={`agent-profile-feature-row-${feature.id}`}>
        <SelectField
          label={feature.label}
          value={feature.value}
          selectedDisplay={selectedDisplay}
          options={selectOptions}
          onChange={handleSelect}
          placeholder={feature.label}
          emptyText={feature.label}
          disabled={disabled}
          {...(feature.description ? { hint: feature.description } : {})}
          title={feature.label}
          size={size}
          testID={`agent-profile-feature-field-${feature.id}`}
          triggerTestID={`agent-profile-feature-trigger-${feature.id}`}
        />
      </View>
    );
  }

  return (
    <View style={rowStyle} testID={`agent-profile-feature-row-${feature.id}`}>
      <View style={styles.featureMeta}>
        <Text style={styles.featureLabel} numberOfLines={1}>
          {feature.label}
        </Text>
        {feature.description ? (
          <Text style={styles.featureDescription} numberOfLines={2}>
            {feature.description}
          </Text>
        ) : null}
      </View>
      <Switch
        value={feature.value === true}
        onValueChange={handleToggle}
        disabled={disabled}
        accessibilityLabel={feature.label}
        testID={`agent-profile-feature-switch-${feature.id}`}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  stack: {
    gap: theme.spacing[4],
  },
  columns: {
    flexDirection: {
      xs: "column",
      md: "row",
    },
    alignItems: "flex-start",
    gap: theme.spacing[6],
  },
  setupColumn: {
    flex: 2,
    alignSelf: "stretch",
    gap: theme.spacing[4],
  },
  instructionsColumn: {
    flex: 3,
    alignSelf: "stretch",
    gap: theme.spacing[4],
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  // No width: the trigger is a glyph and a chevron, so it sizes to them.
  iconField: {
    flexShrink: 0,
  },
  nameField: {
    flex: 1,
  },
  featureCard: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[3],
  },
  featureRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[3],
  },
  featureRowBorder: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  featureMeta: {
    flex: 1,
    gap: theme.spacing[1],
  },
  featureLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  featureDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  notesInput: {
    minHeight: 64,
    textAlignVertical: "top",
  },
  instructionsInput: {
    minHeight: 140,
    textAlignVertical: "top",
  },
  instructionsInputTall: {
    minHeight: 320,
    textAlignVertical: "top",
  },
}));
