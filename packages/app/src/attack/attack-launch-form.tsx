import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Check, Swords } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { ATTACK_ROLE_IDS, type AttackRoleId } from "@pimi/protocol/attack/types";
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
} from "./attack-run-form-model";
import { useAttackStore } from "./attack-store";

const SIZE = "md" as const;
const ROLE_LABEL_KEYS: Record<AttackRoleId, string> = {
  "ui-qa": "attack.roster.uiQa",
  "secrets-audit": "attack.roster.secrets",
};

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

export function LaunchForm({ serverId, workspaceId }: { serverId: string; workspaceId: string }) {
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
    const definition = model.submit();
    if (!definition || !client) return;
    setStarting(true);
    setError(null);
    try {
      const started = await client.attackRunStart({ definition });
      useAttackStore.getState().putRun(serverId, started.run);
    } catch (caught) {
      setError(toErrorMessage(caught));
    } finally {
      setStarting(false);
    }
  }, [client, model, serverId]);
  const onStartPress = useCallback(() => void onStart(), [onStart]);

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
              disabled={role === "secrets-audit" && !state.repoScope}
              label={t(ROLE_LABEL_KEYS[role])}
              model={model}
            />
          ))}
        </View>
      </Field>
      <Field label={t("attack.form.disposable")} hint={t("attack.form.disposableHint")}>
        <Switch
          value={state.disposableTarget}
          onValueChange={model.setDisposableTarget}
          accessibilityLabel={t("attack.form.disposable")}
          testID="attack-disposable"
        />
      </Field>
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

function RosterRow({
  role,
  checked,
  disabled,
  label,
  model,
}: {
  role: AttackRoleId;
  checked: boolean;
  disabled: boolean;
  label: string;
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
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: {
    width: "100%",
    maxWidth: 560,
    gap: theme.spacing[3],
  },
  errorText: {
    color: theme.colors.palette.red[300],
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
