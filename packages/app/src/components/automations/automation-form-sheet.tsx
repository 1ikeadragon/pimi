import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Brain, Folder, GitBranch } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentProvider } from "@pimi/protocol/agent-types";
import type {
  Automation,
  AutomationDefinition,
  AutomationTrigger,
} from "@pimi/protocol/automation/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { ComboboxItem } from "@/components/ui/combobox";
import { Button } from "@/components/ui/button";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import { HostStatusDotSlot } from "@/components/hosts/host-picker";
import { type ControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useProviderIcon } from "@/components/provider-icons";
import { CadenceEditor } from "@/components/automations/cadence-editor";
import {
  SelectField,
  SelectFieldTrigger,
  type SelectFieldDisplay,
  type SelectFieldOption,
  type SelectFieldRenderOptionInput,
} from "@/components/ui/select-field";
import { formatThinkingOptionLabel } from "@/agent-controls/labels";
import { useAgentProfiles } from "@/agent-profiles";
import {
  mergeProviderPreferences,
  useFormPreferences,
  type FormPreferences,
} from "@/hooks/use-form-preferences";
import { useAutomationMutations } from "@/hooks/use-automation-mutations";
import { useProjects } from "@/hooks/use-projects";
import { useHosts } from "@/runtime/host-runtime";
import { buildAutomationProjectTargets } from "@/automations/automation-project-targets";
import type { AutomationTemplate } from "@/automations/automation-templates";
import { useAutomationFormModel } from "@/automations/use-automation-form-model";
import { useAutomationFormProviderSnapshot } from "@/automations/use-automation-form-provider-snapshot";
import type {
  AutomationFormDisplay,
  AutomationFormHost,
  AutomationFormModel,
  AutomationFormSnapshot,
  AutomationFormState,
  AutomationFormTriggerKind,
} from "@/automations/automation-form-model";
import { UNATTENDED_MODE_LABEL } from "@/automations/automation-form-model";
import { validateCron } from "@/utils/automation-format";
import { toErrorMessage } from "@/utils/error-messages";
import { getDeviceTimeZone } from "@/utils/device-timezone";

export interface AutomationFormSheetProps {
  serverId?: string;
  visible: boolean;
  onClose: () => void;
  mode: "create" | "edit";
  automation?: Automation;
  template?: AutomationTemplate;
}

function parseMaxRuns(raw: string): number | null {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function buildTrigger(
  state: AutomationFormState,
  automation: Automation | undefined,
): AutomationTrigger {
  if (state.triggerKind === "manual") {
    return { kind: "manual" };
  }
  if (state.submitCadence) {
    return { kind: "schedule", cadence: state.submitCadence };
  }
  // Editing without touching the cadence keeps the stored one.
  if (automation?.trigger.kind === "schedule") {
    return automation.trigger;
  }
  throw new Error("Choose a cadence before saving this automation");
}

// The form edits a single agent step that reports to chat. On edit, the stored node ids,
// title, feature values and limits other than max runs are kept.
function buildDefinition(input: {
  state: AutomationFormState;
  automation: Automation | undefined;
  provider: AgentProvider;
  cwd: string;
  profileId: string;
}): AutomationDefinition {
  const { state, automation } = input;
  const storedAgent = automation?.flow.nodes.find((node) => node.kind === "agent");
  const storedOutput = automation?.flow.nodes.find((node) => node.kind === "output");
  const agentId = storedAgent?.id ?? "agent";
  const outputId = storedOutput?.id ?? "chat";
  const model = state.selectedModel.trim();
  const modeId = state.selectedMode.trim();
  const thinkingOptionId = state.selectedThinkingOptionId.trim();
  return {
    name: state.name.trim(),
    description: automation?.description ?? null,
    project: { cwd: input.cwd },
    trigger: buildTrigger(state, automation),
    flow: {
      nodes: [
        {
          id: agentId,
          kind: "agent",
          title: storedAgent?.kind === "agent" ? storedAgent.title : "Agent",
          ...(input.profileId ? { profileId: input.profileId } : {}),
          provider: input.provider,
          ...(model ? { model } : {}),
          ...(modeId ? { modeId } : {}),
          ...(thinkingOptionId ? { thinkingOptionId } : {}),
          ...(storedAgent?.kind === "agent" && storedAgent.featureValues
            ? { featureValues: storedAgent.featureValues }
            : {}),
          workspace: state.submitIsolation === "worktree" ? "worktree" : "project",
          prompt: state.prompt.trim(),
        },
        { id: outputId, kind: "output", output: { type: "chat" } },
      ],
      edges: [{ from: agentId, to: outputId }],
    },
    limits: { ...automation?.limits, maxRuns: parseMaxRuns(state.maxRuns) },
  };
}

const TRIGGER_OPTIONS: SelectFieldOption<AutomationFormTriggerKind>[] = [
  {
    id: "schedule",
    value: "schedule",
    label: "On a schedule",
    testID: "automation-trigger-schedule",
  },
  { id: "manual", value: "manual", label: "Run by hand", testID: "automation-trigger-manual" },
];

function resolveCreateServerId(input: {
  mode: "create" | "edit";
  serverId: string | null | undefined;
  hosts: readonly AutomationFormHost[];
}): string | null {
  if (input.mode === "edit") {
    return input.serverId ?? null;
  }
  if (input.serverId !== undefined) {
    return input.serverId;
  }
  if (input.hosts.length === 1) {
    return input.hosts[0]?.serverId ?? null;
  }
  return null;
}

function buildAutomationHostOptionTestId(serverId: string): string {
  return `automation-host-option-${serverId}`;
}

function buildThinkingOptionTestId(optionId: string): string {
  return `automation-thinking-option-${optionId}`;
}

function openKey(props: AutomationFormSheetProps): string {
  if (props.mode === "edit") {
    return `edit:${props.serverId ?? ""}:${props.automation?.id ?? ""}`;
  }
  return `create:${props.serverId ?? ""}:${props.template?.id ?? ""}`;
}

function buildSnapshot(input: {
  mode: "create" | "edit";
  serverId: string | undefined;
  automation: Automation | undefined;
  hosts: readonly AutomationFormHost[];
  projectTargets: ReturnType<typeof buildAutomationProjectTargets>;
  preferences: FormPreferences;
  timezone: string;
  template?: AutomationTemplate;
}): AutomationFormSnapshot {
  const automation = input.automation
    ? { ...input.automation, serverId: input.serverId, serverName: undefined }
    : undefined;
  return {
    mode: input.mode,
    automation,
    hosts: input.hosts,
    defaults: {
      serverId: resolveCreateServerId({
        mode: input.mode,
        serverId: input.serverId,
        hosts: input.hosts,
      }),
      projectTargets: input.projectTargets,
      preferences: input.preferences,
      timezone: input.timezone,
      template: input.template,
    },
  };
}

function updateSelectionPreferences(input: {
  preferences: FormPreferences;
  provider: AgentProvider;
  model: string;
  mode: string;
  thinkingOptionId: string;
  isolation: "local" | "worktree";
}): FormPreferences {
  const model = input.model.trim();
  const mode = input.mode.trim();
  const thinkingOptionId = input.thinkingOptionId.trim();
  return {
    ...mergeProviderPreferences({
      preferences: input.preferences,
      provider: input.provider,
      updates: {
        model: model || undefined,
        mode: mode || undefined,
        ...(model && thinkingOptionId ? { thinkingByModel: { [model]: thinkingOptionId } } : {}),
      },
    }),
    isolation: input.isolation,
  };
}

export function AutomationFormSheet(props: AutomationFormSheetProps): ReactElement | null {
  const [renderedProps, setRenderedProps] = useState<AutomationFormSheetProps | null>(() =>
    props.visible ? props : null,
  );
  const [sheetVisible, setSheetVisible] = useState(props.visible);
  const livePropsRef = useRef(props);
  const closeRequestedRef = useRef(false);
  livePropsRef.current = props;

  useEffect(() => {
    if (props.visible) {
      if (closeRequestedRef.current) {
        return;
      }
      setRenderedProps(props);
      setSheetVisible(true);
      return;
    }
    if (renderedProps) {
      setSheetVisible(false);
    }
  }, [props, renderedProps]);

  const requestClose = useCallback(() => {
    closeRequestedRef.current = true;
    setSheetVisible(false);
  }, []);

  const handleDismiss = useCallback(() => {
    const dismissedProps = livePropsRef.current;
    closeRequestedRef.current = false;
    setRenderedProps(null);
    setSheetVisible(false);
    if (dismissedProps.visible) {
      dismissedProps.onClose();
    }
  }, []);

  if (!renderedProps) {
    return null;
  }

  return (
    <OpenAutomationFormSheet
      key={openKey(renderedProps)}
      {...renderedProps}
      visible={sheetVisible}
      onClose={requestClose}
      onDismiss={handleDismiss}
    />
  );
}

function OpenAutomationFormSheet({
  serverId,
  visible,
  onClose,
  onDismiss,
  mode,
  automation,
  template,
}: AutomationFormSheetProps & { onDismiss: () => void }): ReactElement {
  const controlSize: ControlSize = "md";
  const { projects } = useProjects();
  const hostProfiles = useHosts();
  const hosts = useMemo<AutomationFormHost[]>(
    () => hostProfiles.map((host) => ({ serverId: host.serverId, label: host.label })),
    [hostProfiles],
  );
  const { preferences, updatePreferences } = useFormPreferences();
  const projectTargets = useMemo(() => buildAutomationProjectTargets(projects), [projects]);
  const timezone = useMemo(getDeviceTimeZone, []);
  const snapshot = useMemo(
    () =>
      buildSnapshot({
        mode,
        serverId,
        automation,
        hosts,
        projectTargets,
        preferences,
        timezone,
        template,
      }),
    [hosts, mode, preferences, projectTargets, automation, serverId, timezone, template],
  );
  const model = useAutomationFormModel(snapshot);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const [profileId, setProfileId] = useState(() => {
    const storedAgent = automation?.flow.nodes.find((node) => node.kind === "agent");
    if (storedAgent?.kind === "agent") {
      return storedAgent.profileId ?? "";
    }
    return template?.profileId ?? "";
  });
  const providerSnapshot = useAutomationFormProviderSnapshot(model, state);
  const mutationServerId = state.selectedServerId ?? serverId ?? "";
  const { createAutomation, updateAutomation, isCreating, isUpdating } = useAutomationMutations({
    serverId: mutationServerId,
  });

  const isSubmitting = isCreating || isUpdating;
  const cadenceError =
    state.triggerKind === "schedule" && state.cadence.type === "cron"
      ? validateCron(state.cadence.expression)
      : null;
  const canSubmit = state.canSubmit && cadenceError === null && !isSubmitting;
  const persistPreferences = useCallback(async () => {
    const provider = state.selectedProvider;
    if (!provider) {
      return;
    }
    await updatePreferences((current) =>
      updateSelectionPreferences({
        preferences: current,
        provider,
        model: state.selectedModel,
        mode: state.selectedMode,
        thinkingOptionId: state.selectedThinkingOptionId,
        isolation: state.isolation,
      }),
    );
  }, [
    state.isolation,
    state.selectedMode,
    state.selectedModel,
    state.selectedProvider,
    state.selectedThinkingOptionId,
    updatePreferences,
  ]);

  const submit = useCallback(async (): Promise<boolean> => {
    const provider = state.selectedProvider;
    const cwd = state.workingDir.trim();
    if (!provider || !cwd) {
      return false;
    }
    await persistPreferences();
    const definition = buildDefinition({ state, automation, provider, cwd, profileId });
    if (mode === "edit" && automation) {
      await updateAutomation({ automationId: automation.id, definition });
      return true;
    }
    await createAutomation({ definition });
    return true;
  }, [createAutomation, mode, persistPreferences, automation, profileId, state, updateAutomation]);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) {
      return;
    }
    model.setSubmitError(null);
    try {
      if (await submit()) {
        onClose();
      }
    } catch (error) {
      model.setSubmitError(toErrorMessage(error));
    }
  }, [canSubmit, model, onClose, submit]);

  const handleSubmitPress = useCallback(() => {
    void handleSubmit();
  }, [handleSubmit]);

  const header = useMemo<SheetHeader>(
    () => ({ title: mode === "edit" ? "Edit automation" : "New automation" }),
    [mode],
  );

  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button
          style={styles.footerButton}
          variant="secondary"
          onPress={onClose}
          disabled={isSubmitting}
        >
          Cancel
        </Button>
        <Button
          style={styles.footerButton}
          variant="default"
          onPress={handleSubmitPress}
          disabled={!canSubmit}
          loading={isSubmitting}
          testID="automation-form-submit"
        >
          {mode === "edit" ? "Save changes" : "Create automation"}
        </Button>
      </View>
    ),
    [canSubmit, handleSubmitPress, isSubmitting, mode, onClose],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      onDismiss={onDismiss}
      footer={footer}
      testID="automation-form-sheet"
    >
      <AutomationFormFields
        model={model}
        state={state}
        providerSnapshot={providerSnapshot}
        controlSize={controlSize}
        cadenceError={cadenceError}
        mutationServerId={mutationServerId}
        profileId={profileId}
        onChangeProfileId={setProfileId}
      />
    </AdaptiveModalSheet>
  );
}

interface AutomationFormFieldsProps {
  model: AutomationFormModel;
  state: AutomationFormState;
  providerSnapshot: ReturnType<typeof useAutomationFormProviderSnapshot>;
  controlSize: ControlSize;
  cadenceError: string | null;
  mutationServerId: string;
  profileId: string;
  onChangeProfileId: (profileId: string) => void;
}

function AutomationFormFields({
  model,
  state,
  providerSnapshot,
  controlSize,
  cadenceError,
  mutationServerId,
  profileId,
  onChangeProfileId,
}: AutomationFormFieldsProps): ReactElement {
  const triggerDisplay = useMemo<SelectFieldDisplay>(
    () => ({ label: state.triggerKind === "manual" ? "Run by hand" : "On a schedule" }),
    [state.triggerKind],
  );
  return (
    <>
      <Field label="Name">
        <FormTextInput
          size={controlSize}
          testID="automation-name-input"
          accessibilityLabel="Automation name"
          initialValue={state.name}
          onChangeText={model.setName}
          placeholder="Weekday PR review"
          autoCapitalize="sentences"
          autoCorrect={false}
        />
      </Field>

      <Field label="Prompt">
        <FormTextInput
          size={controlSize}
          testID="automation-prompt-input"
          accessibilityLabel="Prompt"
          initialValue={state.prompt}
          onChangeText={model.setPrompt}
          placeholder="What should the agent do each run?"
          style={styles.multilineInput}
          multiline
          numberOfLines={4}
          textAlignVertical="top"
        />
      </Field>

      <AutomationProfileField
        serverId={state.selectedServerId}
        value={profileId}
        onChange={onChangeProfileId}
        size={controlSize}
      />

      <SelectField
        label="Trigger"
        value={state.triggerKind}
        selectedDisplay={triggerDisplay}
        options={TRIGGER_OPTIONS}
        onChange={model.setTriggerKind}
        placeholder="Select trigger"
        emptyText="No triggers found"
        searchable={false}
        title="Trigger"
        size={controlSize}
        triggerTestID="automation-trigger-trigger"
      />

      {state.triggerKind === "schedule" ? (
        <CadenceEditor
          value={state.cadence}
          onChange={model.setCadence}
          error={cadenceError ?? undefined}
          size={controlSize}
        />
      ) : null}

      <AutomationTargetFields
        model={model}
        state={state}
        providerSnapshot={providerSnapshot}
        controlSize={controlSize}
        mutationServerId={mutationServerId}
      />

      <Field label="Max runs">
        <FormTextInput
          size={controlSize}
          testID="automation-max-runs-input"
          accessibilityLabel="Max runs"
          initialValue={state.maxRuns}
          onChangeText={model.setMaxRuns}
          placeholder="Unlimited"
          keyboardType="number-pad"
        />
      </Field>

      {state.submitError ? <Text style={styles.submitError}>{state.submitError}</Text> : null}
    </>
  );
}

const NO_PROFILE_VALUE = "__none__";

// Profiles live on a host, so the list follows the selected host. A stored or template profile the
// host does not have is dropped, which also repairs an automation whose profile was deleted.
function AutomationProfileField({
  serverId,
  value,
  onChange,
  size,
}: {
  serverId: string | null;
  value: string;
  onChange: (profileId: string) => void;
  size: ControlSize;
}): ReactElement {
  const { t } = useTranslation();
  const { profiles } = useAgentProfiles(serverId);
  useEffect(() => {
    if (profiles && value && !profiles.some((profile) => profile.id === value)) {
      onChange("");
    }
  }, [onChange, profiles, value]);
  const options = useMemo<SelectFieldOption<string>[]>(
    () => [
      {
        id: NO_PROFILE_VALUE,
        value: NO_PROFILE_VALUE,
        label: t("profiles.automationNoProfile"),
        testID: "automation-profile-option-none",
      },
      ...(profiles ?? []).map((profile) => ({
        id: profile.id,
        value: profile.id,
        label: profile.name,
        description: profile.notes,
        testID: `automation-profile-option-${profile.id}`,
      })),
    ],
    [profiles, t],
  );
  const selected = profiles?.find((profile) => profile.id === value) ?? null;
  const selectedDisplay = useMemo<SelectFieldDisplay>(
    () => ({ label: selected?.name ?? t("profiles.automationNoProfile") }),
    [selected, t],
  );
  const handleChange = useCallback(
    (next: string) => onChange(next === NO_PROFILE_VALUE ? "" : next),
    [onChange],
  );
  return (
    <SelectField
      label={t("profiles.automationProfileLabel")}
      hint={t("profiles.automationProfileHint")}
      value={selected ? selected.id : NO_PROFILE_VALUE}
      selectedDisplay={selectedDisplay}
      options={options}
      onChange={handleChange}
      placeholder={t("profiles.automationNoProfile")}
      emptyText={t("profiles.empty")}
      loading={serverId !== null && profiles === null}
      disabled={!serverId}
      searchable={options.length > 7}
      title={t("profiles.automationProfileLabel")}
      size={size}
      triggerTestID="automation-profile-trigger"
    />
  );
}

interface AutomationTargetFieldsProps {
  model: AutomationFormModel;
  state: AutomationFormState;
  providerSnapshot: ReturnType<typeof useAutomationFormProviderSnapshot>;
  controlSize: ControlSize;
  mutationServerId: string;
}

function AutomationTargetFields({
  model,
  state,
  providerSnapshot,
  controlSize,
  mutationServerId,
}: AutomationTargetFieldsProps): ReactElement {
  const hostOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      state.hosts.map((host) => ({
        id: host.serverId,
        value: host.serverId,
        label: host.label,
        testID: buildAutomationHostOptionTestId(host.serverId),
      })),
    [state.hosts],
  );
  const selectedHost = state.hosts.find((host) => host.serverId === state.selectedServerId) ?? null;
  const selectedHostDisplay = useMemo<SelectFieldDisplay | null>(() => {
    if (selectedHost) {
      return { label: selectedHost.label };
    }
    if (state.selectedServerId) {
      return { label: state.selectedServerId };
    }
    return null;
  }, [selectedHost, state.selectedServerId]);
  const projectOptions = state.projectOptions;
  const modeOptions = useMemo<SelectFieldOption<string>[]>(
    () => [
      {
        id: "automation-mode-unattended",
        value: "",
        label: UNATTENDED_MODE_LABEL,
        description: "Runs without asking for permission",
      },
      ...state.modeOptions.map((option) => ({
        id: option.id,
        value: option.id,
        label: option.label,
      })),
    ],
    [state.modeOptions],
  );
  const thinkingOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      state.availableThinkingOptions.map((option) => ({
        id: option.id,
        value: option.id,
        label: formatThinkingOptionLabel(option),
        testID: buildThinkingOptionTestId(option.id),
      })),
    [state.availableThinkingOptions],
  );
  const handleSelectHost = useCallback(
    (nextServerId: string) => {
      model.setHost(nextServerId);
    },
    [model],
  );
  const handleSelectProject = useCallback(
    (optionId: string, display: AutomationFormDisplay) => {
      model.setProject(optionId, display);
    },
    [model],
  );
  const handleSelectModel = useCallback(
    (provider: AgentProvider, modelId: string) => {
      model.setModel(provider, modelId);
    },
    [model],
  );
  const handleSelectMode = useCallback(
    (modeId: string) => {
      model.setSessionMode(modeId);
    },
    [model],
  );
  const handleSelectThinking = useCallback(
    (thinkingOptionId: string) => {
      model.setThinking(thinkingOptionId);
    },
    [model],
  );
  const handleModelOpen = useCallback(() => {
    providerSnapshot.refetchIfStale(state.selectedProvider);
  }, [providerSnapshot, state.selectedProvider]);
  const handleRetryProvider = useCallback(
    (provider: AgentProvider) => {
      void providerSnapshot.refresh([provider]);
    },
    [providerSnapshot],
  );
  const renderHostOption = useCallback(
    (input: SelectFieldRenderOptionInput<string>) => <HostOptionItem {...input} />,
    [],
  );
  const renderProjectOption = useCallback(
    (input: SelectFieldRenderOptionInput<string>) => <ProjectOptionItem {...input} />,
    [],
  );
  const renderThinkingOption = useCallback(
    (input: SelectFieldRenderOptionInput<string>) => <ThinkingOptionItem {...input} />,
    [],
  );
  const modelTriggerLeading = useMemo(
    () => <ProviderGlyph provider={state.selectedProvider} serverId={state.selectedServerId} />,
    [state.selectedProvider, state.selectedServerId],
  );
  const renderModelTrigger = useCallback(
    ({
      selectedModelLabel,
      disabled,
      isOpen,
      hovered,
      pressed,
    }: {
      selectedModelLabel: string;
      onPress: () => void;
      disabled: boolean;
      isOpen: boolean;
      hovered: boolean;
      pressed: boolean;
    }): ReactNode => {
      const displayLabel = state.selectedModelDisplay?.label ?? selectedModelLabel;
      return (
        <SelectFieldTrigger
          label={displayLabel}
          isPlaceholder={!state.selectedModel}
          placeholder={displayLabel}
          leading={modelTriggerLeading}
          disabled={disabled}
          active={hovered || pressed || isOpen}
          size={controlSize}
          testID="automation-model-trigger"
        />
      );
    },
    [controlSize, modelTriggerLeading, state.selectedModel, state.selectedModelDisplay],
  );

  return (
    <>
      {state.mode === "edit" || state.hosts.length > 1 ? (
        <SelectField
          label="Host"
          value={state.selectedServerId}
          selectedDisplay={selectedHostDisplay}
          options={hostOptions}
          onChange={handleSelectHost}
          placeholder="Select host"
          emptyText="No hosts found"
          disabled={state.mode === "edit"}
          searchable={false}
          title="Host"
          size={controlSize}
          triggerTestID="automation-host-trigger"
          renderOption={renderHostOption}
        />
      ) : null}

      {state.disclosure.showProjectField ? (
        <SelectField
          label="Project"
          value={state.selectedProjectOptionId || null}
          selectedDisplay={state.projectDisplay}
          options={projectOptions}
          onChange={handleSelectProject}
          placeholder="Select project"
          emptyText="No projects found"
          disabled={!state.selectedServerId}
          hint={!state.selectedServerId ? "Choose a host first." : undefined}
          searchable
          searchPlaceholder="Search projects..."
          title="Select project"
          size={controlSize}
          triggerTestID="automation-project-trigger"
          renderOption={renderProjectOption}
        />
      ) : null}

      {state.disclosure.showModelField ? (
        <Field label="Model">
          <CombinedModelSelector
            providers={state.modelSelectorProviders}
            selectedProvider={state.selectedProvider ?? ""}
            selectedModel={state.selectedModel}
            onSelect={handleSelectModel}
            isLoading={providerSnapshot.isLoading || providerSnapshot.isFetching}
            renderTrigger={renderModelTrigger}
            triggerFill
            serverId={mutationServerId}
            disabled={!state.selectedServerId}
            onOpen={handleModelOpen}
            onRetryProvider={handleRetryProvider}
            isRetryingProvider={providerSnapshot.isRefreshing}
          />
        </Field>
      ) : null}

      {state.disclosure.showThinkingField ? (
        <SelectField
          label="Thinking"
          value={state.selectedThinkingOptionId || null}
          selectedDisplay={state.selectedThinkingDisplay}
          options={thinkingOptions}
          onChange={handleSelectThinking}
          placeholder="Select thinking"
          emptyText="No thinking options found"
          searchable={thinkingOptions.length > 6}
          title="Select thinking"
          size={controlSize}
          triggerTestID="automation-thinking-trigger"
          renderOption={renderThinkingOption}
        />
      ) : null}

      {state.disclosure.showModeField ? (
        <SelectField
          label="Mode"
          value={state.selectedMode}
          selectedDisplay={state.selectedModeDisplay}
          options={modeOptions}
          onChange={handleSelectMode}
          placeholder={UNATTENDED_MODE_LABEL}
          emptyText="No modes found"
          searchable={modeOptions.length > 7}
          title="Select mode"
          size={controlSize}
          triggerTestID="automation-mode-trigger"
        />
      ) : null}

      {state.disclosure.showIsolationField ? (
        <AutomationIsolationField model={model} state={state} size={controlSize} />
      ) : null}
    </>
  );
}

function AutomationIsolationField({
  model,
  state,
  size,
}: {
  model: AutomationFormModel;
  state: AutomationFormState;
  size: ControlSize;
}): ReactElement {
  const options = useMemo<SelectFieldOption<"local" | "worktree">[]>(
    () => [
      {
        id: "local",
        value: "local",
        label: "Local",
        testID: "automation-isolation-local",
      },
      {
        id: "worktree",
        value: "worktree",
        label: "Worktree",
        testID: "automation-isolation-worktree",
      },
    ],
    [],
  );
  const selectedDisplay = useMemo<SelectFieldDisplay>(
    () => ({ label: state.effectiveIsolation === "worktree" ? "Worktree" : "Local" }),
    [state.effectiveIsolation],
  );
  const triggerLeading = useMemo(
    () => (
      <View style={styles.optionIconBox}>
        {state.effectiveIsolation === "worktree" ? (
          <GitBranch size={16} color={styles.providerIcon.color} />
        ) : (
          <Folder size={16} color={styles.providerIcon.color} />
        )}
      </View>
    ),
    [state.effectiveIsolation],
  );
  const handleSelectIsolation = useCallback(
    (value: "local" | "worktree") => {
      model.setIsolation(value);
    },
    [model],
  );
  const renderIsolationOption = useCallback(
    (input: SelectFieldRenderOptionInput<"local" | "worktree">) => (
      <IsolationOptionItem {...input} />
    ),
    [],
  );

  return (
    <SelectField
      label="Isolation"
      value={state.effectiveIsolation}
      selectedDisplay={selectedDisplay}
      options={options}
      onChange={handleSelectIsolation}
      placeholder="Select isolation"
      emptyText="No isolation options found"
      searchable={false}
      title="Isolation"
      size={size}
      testID="automation-isolation"
      triggerTestID="automation-isolation-trigger"
      triggerLeading={triggerLeading}
      renderOption={renderIsolationOption}
    />
  );
}

function IsolationOptionItem({
  option,
  selected,
  active,
  onPress,
}: SelectFieldRenderOptionInput<"local" | "worktree">): ReactElement {
  const leadingSlot = useMemo(
    () => (
      <View style={styles.optionIconBox}>
        {option.value === "worktree" ? (
          <GitBranch size={16} color={styles.providerIcon.color} />
        ) : (
          <Folder size={16} color={styles.providerIcon.color} />
        )}
      </View>
    ),
    [option.value],
  );

  return (
    <ComboboxItem
      testID={option.testID}
      label={option.label}
      selected={selected}
      active={active}
      onPress={onPress}
      leadingSlot={leadingSlot}
    />
  );
}

function HostOptionItem({
  option,
  selected,
  active,
  onPress,
}: SelectFieldRenderOptionInput<string>): ReactElement {
  const leadingSlot = useMemo(() => <HostStatusDotSlot serverId={option.value} />, [option.value]);

  return (
    <ComboboxItem
      testID={option.testID}
      label={option.label}
      selected={selected}
      active={active}
      onPress={onPress}
      leadingSlot={leadingSlot}
    />
  );
}

function ProjectOptionItem({
  option,
  selected,
  active,
  onPress,
}: SelectFieldRenderOptionInput<string>): ReactElement {
  const leadingSlot = useMemo(
    () => (
      <View style={styles.optionIconBox}>
        <Folder size={16} color={styles.providerIcon.color} />
      </View>
    ),
    [],
  );

  return (
    <ComboboxItem
      testID={option.testID}
      label={option.label}
      selected={selected}
      active={active}
      onPress={onPress}
      leadingSlot={leadingSlot}
    />
  );
}

function ThinkingOptionItem({
  option,
  selected,
  active,
  onPress,
}: SelectFieldRenderOptionInput<string>): ReactElement {
  const leadingSlot = useMemo(
    () => (
      <View style={styles.optionIconBox}>
        <Brain size={16} color={styles.providerIcon.color} />
      </View>
    ),
    [],
  );

  return (
    <ComboboxItem
      testID={option.testID}
      label={option.label}
      selected={selected}
      active={active}
      onPress={onPress}
      leadingSlot={leadingSlot}
    />
  );
}

function ProviderGlyph({
  provider,
  serverId,
}: {
  provider: string | null;
  serverId: string | null;
}): ReactElement | null {
  const Icon = useProviderIcon(provider ?? "", serverId);
  if (!provider) {
    return null;
  }
  return <Icon size={16} color={styles.providerIcon.color} />;
}

const styles = StyleSheet.create((theme) => {
  return {
    multilineInput: {
      minHeight: 96,
    },
    optionIconBox: {
      width: 18,
      height: 18,
      alignItems: "center",
      justifyContent: "center",
    },
    footer: {
      flex: 1,
      flexDirection: "row",
      gap: theme.spacing[3],
    },
    footerButton: {
      flex: 1,
    },
    submitError: {
      color: theme.colors.palette.red[300],
      fontSize: theme.fontSize.sm,
    },
    providerIcon: {
      color: theme.colors.foregroundMuted,
    },
  };
});
