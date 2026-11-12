import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Check, Crosshair, RefreshCw, Swords } from "lucide-react-native";
import type { AttackAnnotation, AttackDesktopTarget } from "@pimi/protocol/attack/types";
import { StyleSheet } from "react-native-unistyles";
import {
  ATTACK_ROLE_IDS,
  ATTACK_ROLE_REQUIREMENTS,
  type AttackRoleId,
} from "@pimi/protocol/attack/types";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { toErrorMessage } from "@/utils/error-messages";
import {
  openAttackRunForm,
  type AttackModelOption,
  type AttackRunFormModel,
  type AttackRunFormState,
} from "./attack-run-form-model";
import { useAttackStore } from "./attack-store";
import { getDesktopHost } from "@/desktop/host";
import { hasDesktopTargetBridge, listDesktopWindows } from "./use-desktop-target";

const SIZE = "md" as const;
const ROLE_LABEL_KEYS: Record<AttackRoleId, string> = {
  recon: "attack.roster.recon",
  "ui-qa": "attack.roster.uiQa",
  api: "attack.roster.api",
  auth: "attack.roster.auth",
  input: "attack.roster.input",
  "secrets-audit": "attack.roster.secrets",
  "perf-lite": "attack.roster.perfLite",
};

function roleHintKey(role: AttackRoleId): string {
  const needs = ATTACK_ROLE_REQUIREMENTS[role];
  if (needs.testCredentials) return "attack.roster.needsCredentials";
  if (needs.repository) return "attack.roster.needsRepository";
  if (needs.disposableTarget) return "attack.roster.needsDisposable";
  return "attack.roster.readOnly";
}

function useModelOptions(serverId: string, cwd: string): AttackModelOption[] {
  const { entries } = useProvidersSnapshot(serverId, { cwd });
  const options: AttackModelOption[] = [];
  for (const entry of entries ?? []) {
    if (entry.status !== "ready" || !entry.enabled) continue;
    for (const model of entry.models ?? []) {
      if (model.isSelectable === false) continue;
      options.push({
        value: `${entry.provider}/${model.id}`,
        label: `${entry.label ?? entry.provider} · ${model.label}`,
      });
    }
  }
  return options;
}

export function LaunchForm({
  serverId,
  workspaceId,
  annotations,
  onlyAnnotated,
  preflightOpen,
  onOpenPreflight,
  onStarted,
}: {
  serverId: string;
  workspaceId: string;
  annotations: AttackAnnotation[];
  onlyAnnotated: boolean;
  preflightOpen: boolean;
  onOpenPreflight: (target: string) => void;
  onStarted: () => void;
}) {
  const { t } = useTranslation();
  const cwd = useWorkspaceDirectory(serverId, workspaceId) ?? "";
  const client = useHostRuntimeClient(serverId);
  const [model] = useState<AttackRunFormModel>(() => openAttackRunForm({ workspaceId, cwd }));
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const options = useModelOptions(serverId, cwd);
  const optionsKey = options.map((option) => option.value).join("|");
  useEffect(() => {
    model.applyModelOptions(options);
    // The options array is rebuilt each render; its content key is the real input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, optionsKey]);
  useEffect(() => () => model.close(), [model]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onStart = useCallback(async () => {
    const definition = model.submit({ annotations, onlyAnnotated });
    if (!definition || !client) return;
    setStarting(true);
    setError(null);
    try {
      const started = await client.attackRunStart({ definition });
      useAttackStore.getState().putRun(serverId, started.run);
      onStarted();
    } catch (caught) {
      setError(toErrorMessage(caught));
    } finally {
      setStarting(false);
    }
  }, [annotations, client, model, onStarted, onlyAnnotated, serverId]);
  const onStartPress = useCallback(() => void onStart(), [onStart]);
  const onPreflightPress = useCallback(() => {
    if (model.checkTarget()) onOpenPreflight(model.getState().target.trim());
  }, [model, onOpenPreflight]);

  const modelOptions = useMemo<SelectFieldOption<AttackModelOption>[]>(
    () =>
      state.modelOptions.map((option) => ({
        id: option.value,
        value: option,
        label: option.label,
      })),
    [state.modelOptions],
  );
  const selectedDisplay = useMemo(
    () => (state.model ? { label: state.model.label } : null),
    [state.model],
  );

  return (
    <View style={styles.section} testID="attack-launch-form">
      <Field
        label={t("attack.form.target")}
        error={state.problems.targetInvalid ? t("attack.form.targetInvalid") : null}
        hint={
          state.remoteHost ? t("attack.form.remoteHost", { host: state.remoteHost }) : undefined
        }
      >
        <FormTextInput
          size={SIZE}
          testID="attack-target-input"
          accessibilityLabel={t("attack.form.target")}
          initialValue={state.target}
          onChangeText={model.setTarget}
          placeholder="http://localhost:3000"
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>
      {hasDesktopTargetBridge() ? <DesktopTargetSection model={model} state={state} /> : null}
      <Field label={t("attack.form.repoScope")}>
        <View style={styles.switchRow}>
          <Text style={styles.switchText} numberOfLines={1}>
            {cwd}
          </Text>
          <Switch
            value={state.repoScope}
            onValueChange={model.setRepoScope}
            accessibilityLabel={t("attack.form.repoScope")}
            testID="attack-repo-scope"
          />
        </View>
      </Field>
      <Field label={t("attack.form.scopeNotes")}>
        <FormTextInput
          size={SIZE}
          testID="attack-scope-input"
          accessibilityLabel={t("attack.form.scopeNotes")}
          initialValue={state.scopeNotes}
          onChangeText={model.setScopeNotes}
          style={styles.multiline}
          multiline
          numberOfLines={3}
          textAlignVertical="top"
        />
      </Field>
      <View style={styles.budgetRow}>
        <View style={styles.budgetField}>
          <Field
            label={t("attack.form.minutes")}
            error={state.problems.minutesInvalid ? t("attack.form.numberInvalid") : null}
          >
            <FormTextInput
              size={SIZE}
              testID="attack-minutes-input"
              accessibilityLabel={t("attack.form.minutes")}
              initialValue={state.minutes}
              onChangeText={model.setMinutes}
              keyboardType="number-pad"
            />
          </Field>
        </View>
        <View style={styles.budgetField}>
          <Field
            label={t("attack.form.kiloTokens")}
            error={state.problems.tokensInvalid ? t("attack.form.numberInvalid") : null}
          >
            <FormTextInput
              size={SIZE}
              testID="attack-tokens-input"
              accessibilityLabel={t("attack.form.kiloTokens")}
              initialValue={state.kiloTokens}
              onChangeText={model.setKiloTokens}
              keyboardType="number-pad"
            />
          </Field>
        </View>
      </View>
      <SelectField
        label={t("attack.form.model")}
        value={state.model}
        selectedDisplay={selectedDisplay}
        options={modelOptions}
        onChange={model.setModel}
        placeholder={t("attack.form.modelPlaceholder")}
        hint={state.model?.value.startsWith("claude/") ? undefined : t("attack.form.modelHint")}
        emptyText={t("attack.form.modelPlaceholder")}
        error={state.problems.modelMissing ? t("attack.form.modelMissing") : null}
        getValueKey={getModelKey}
        size={SIZE}
        testID="attack-model-select"
      />
      <Field
        label={t("attack.form.roster")}
        error={state.problems.rosterEmpty ? t("attack.form.rosterEmpty") : null}
      >
        <View style={styles.rosterList}>
          {ATTACK_ROLE_IDS.map((role) => (
            <RosterRow
              key={role}
              role={role}
              checked={state.roster[role]}
              disabled={ATTACK_ROLE_REQUIREMENTS[role].repository && !state.repoScope}
              label={t(ROLE_LABEL_KEYS[role])}
              hint={t(roleHintKey(role))}
              model={model}
            />
          ))}
        </View>
      </Field>
      <WriteOptIn model={model} state={state} />
      <Text style={styles.noteText} testID="attack-confinement-note">
        {t("attack.form.confinement")}
      </Text>
      {preflightOpen ? null : (
        <Button
          variant="outline"
          leftIcon={Crosshair}
          onPress={onPreflightPress}
          testID="attack-preflight-open"
        >
          {t("attack.form.preflight")}
        </Button>
      )}
      <Button
        variant="default"
        leftIcon={Swords}
        loading={starting}
        disabled={starting || !client}
        onPress={onStartPress}
        testID="attack-start"
      >
        {t("attack.form.start")}
      </Button>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );
}

function getModelKey(option: AttackModelOption): string {
  return option.value;
}

const NO_WINDOW: AttackDesktopTarget = { bundleId: "", appName: "", windowTitle: "" };

function getWindowKey(window: AttackDesktopTarget): string {
  return `${window.bundleId}\u0000${window.windowTitle}`;
}

// The owner picks the one window the agents may drive; the desktop app enforces it on every call.
function DesktopTargetSection({
  model,
  state,
}: {
  model: AttackRunFormModel;
  state: AttackRunFormState;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const listed = await listDesktopWindows();
      setError(listed.error);
      model.applyDesktopWindows(listed.windows);
    } catch (caught) {
      setError(toErrorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [model]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const onRefresh = useCallback(() => void refresh(), [refresh]);
  const onGrant = useCallback(() => {
    const bridge = getDesktopHost()?.desktopTarget;
    if (!bridge) return;
    void bridge
      .permissions({ prompt: true })
      .catch(() => undefined)
      .then(() => refresh());
  }, [refresh]);
  const options = useMemo<SelectFieldOption<AttackDesktopTarget>[]>(
    () => [
      { id: "none", value: NO_WINDOW, label: t("attack.form.desktopNone") },
      ...state.desktopWindows.map((window) => ({
        id: getWindowKey(window),
        value: window,
        label: `${window.appName} · ${window.windowTitle}`,
      })),
    ],
    [state.desktopWindows, t],
  );
  const picked = state.desktopTarget;
  const onChange = useCallback(
    (value: AttackDesktopTarget) => model.setDesktopTarget(value.bundleId === "" ? null : value),
    [model],
  );
  const selectedDisplay = useMemo(
    () => ({
      label: picked ? `${picked.appName} · ${picked.windowTitle}` : t("attack.form.desktopNone"),
    }),
    [picked, t],
  );
  return (
    <View style={styles.desktopSection} testID="attack-desktop-section">
      <SelectField
        label={t("attack.form.desktopWindow")}
        value={picked ?? NO_WINDOW}
        selectedDisplay={selectedDisplay}
        options={options}
        onChange={onChange}
        placeholder={t("attack.form.desktopNone")}
        emptyText={t("attack.form.desktopNone")}
        hint={t("attack.form.desktopHint")}
        getValueKey={getWindowKey}
        loading={loading}
        size={SIZE}
        testID="attack-desktop-select"
      />
      <View style={styles.desktopActions}>
        <Button variant="outline" size="sm" leftIcon={RefreshCw} onPress={onRefresh}>
          {t("attack.form.desktopRefresh")}
        </Button>
        {error ? (
          <Button variant="outline" size="sm" onPress={onGrant}>
            {t("attack.subviews.desktop.grantAccess")}
          </Button>
        ) : null}
      </View>
      {error ? (
        <Text style={styles.errorText} testID="attack-desktop-list-error">
          {error}
        </Text>
      ) : null}
      {picked ? (
        <Field label={t("attack.form.desktopInput")} hint={t("attack.form.desktopInputHint")}>
          <Switch
            value={state.allowDesktopInput}
            onValueChange={model.setAllowDesktopInput}
            accessibilityLabel={t("attack.form.desktopInput")}
            testID="attack-desktop-input-switch"
          />
        </Field>
      ) : null}
    </View>
  );
}

function WriteOptIn({ model, state }: { model: AttackRunFormModel; state: AttackRunFormState }) {
  const { t } = useTranslation();
  const confirmLabel = t("attack.form.disposableConfirm", {
    host: state.disposableConfirmWord ?? "",
  });
  return (
    <>
      {state.roster.auth ? (
        <Field
          label={t("attack.form.credentials")}
          hint={t("attack.form.credentialsHint")}
          error={state.problems.credentialsMissing ? t("attack.form.credentialsMissing") : null}
        >
          <FormTextInput
            size={SIZE}
            testID="attack-credentials-input"
            accessibilityLabel={t("attack.form.credentials")}
            initialValue={state.testCredentials}
            onChangeText={model.setTestCredentials}
            style={styles.multiline}
            multiline
            numberOfLines={2}
            textAlignVertical="top"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </Field>
      ) : null}
      <Field
        label={t("attack.form.disposable")}
        hint={t("attack.form.disposableHint")}
        error={state.problems.disposableRequired ? t("attack.form.disposableRequired") : null}
      >
        <Switch
          value={state.disposableTarget}
          onValueChange={model.setDisposableTarget}
          accessibilityLabel={t("attack.form.disposable")}
          testID="attack-disposable"
        />
      </Field>
      {state.disposableTarget ? (
        <Field
          label={confirmLabel}
          error={state.problems.disposableUnconfirmed ? t("attack.form.disposableMismatch") : null}
        >
          <FormTextInput
            size={SIZE}
            testID="attack-disposable-confirm"
            accessibilityLabel={confirmLabel}
            initialValue={state.disposableConfirm}
            onChangeText={model.setDisposableConfirm}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </Field>
      ) : null}
    </>
  );
}

function RosterRow({
  role,
  checked,
  disabled,
  label,
  hint,
  model,
}: {
  role: AttackRoleId;
  checked: boolean;
  disabled: boolean;
  label: string;
  hint: string;
  model: AttackRunFormModel;
}) {
  const onPress = useCallback(() => model.toggleRole(role), [model, role]);
  const accessibilityState = useMemo(() => ({ checked, disabled }), [checked, disabled]);
  return (
    <PressHighlight
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="checkbox"
      accessibilityState={accessibilityState}
      accessibilityLabel={label}
      style={[styles.rosterRow, disabled && styles.rosterRowDisabled]}
      testID={`attack-roster-${role}`}
    >
      <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
        {checked ? <Check size={12} color="white" /> : null}
      </View>
      <Text style={styles.rosterLabel}>{label}</Text>
      <Text style={styles.rosterHint}>{hint}</Text>
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  desktopSection: { gap: theme.spacing[2] },
  desktopActions: { flexDirection: "row", gap: theme.spacing[2], flexWrap: "wrap" },
  section: {
    width: "100%",
    maxWidth: 560,
    gap: theme.spacing[3],
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
  noteText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  switchText: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
  multiline: {
    minHeight: 72,
  },
  budgetRow: {
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  budgetField: {
    flex: 1,
    minWidth: 0,
  },
  rosterList: {
    gap: theme.spacing[2],
  },
  rosterRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  rosterRowDisabled: {
    opacity: 0.5,
  },
  rosterLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  rosterHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  checkbox: {
    width: 16,
    height: 16,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxChecked: {
    backgroundColor: theme.colors.palette.red[600],
    borderColor: theme.colors.palette.red[600],
  },
}));
