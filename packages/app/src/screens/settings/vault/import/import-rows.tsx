import { useCallback, useReducer } from "react";
import { Text, View } from "react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { StyleSheet } from "react-native-unistyles";
import { secretNameFromEnvName } from "@pimi/protocol/vault/types";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { Switch } from "@/components/ui/switch";
import { useTranslation } from "@/i18n/use-translation";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { secretNameIssues, vaultErrorMessage, vaultRoot } from "../use-vault";

export interface ImportCandidate {
  id: string;
  label: string;
  variable: string;
  value: string;
}

interface ImportState {
  selection: Record<string, boolean>;
  variables: Record<string, string>;
}

type ImportAction =
  | { type: "select"; id: string; selected: boolean }
  | { type: "variable"; id: string; variable: string };

function importReducer(state: ImportState, action: ImportAction): ImportState {
  if (action.type === "select") {
    return { ...state, selection: { ...state.selection, [action.id]: action.selected } };
  }
  return { ...state, variables: { ...state.variables, [action.id]: action.variable } };
}

interface ImportRowsProps {
  serverId: string;
  operator: boolean;
  candidates: ImportCandidate[];
  /** Rows are chosen when they appear (.env lines) or only when the user picks them (a CSV). */
  defaultSelected: boolean;
  onAdded: (result: ImportResult) => void;
}

export interface ImportResult {
  count: number;
  /** Every chosen row went in, so the source text can be cleared. */
  complete: boolean;
}

interface RowFailure {
  variable: string;
  message: string;
}

interface ImportOutcome {
  added: number;
  failures: RowFailure[];
}

/**
 * The shared list behind both imports: pick rows, name the variable, add. The values stay in this
 * component's props and are dropped with it; nothing is logged or stored in a query cache.
 */
export function ImportRows({
  serverId,
  operator,
  candidates,
  defaultSelected,
  onAdded,
}: ImportRowsProps) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(importReducer, { selection: {}, variables: {} });
  const rows = candidates.map((candidate) => {
    const variable = state.variables[candidate.id] ?? candidate.variable;
    const selected = state.selection[candidate.id] ?? defaultSelected;
    return {
      candidate,
      variable,
      selected,
      issues: secretNameIssues(secretNameFromEnvName(variable), variable),
    };
  });
  const chosen = rows.filter((row) => row.selected);
  const canSubmit = operator && chosen.length > 0 && chosen.every((row) => row.issues.valid);
  const add = useMutation({
    mutationFn: async (): Promise<ImportOutcome> => {
      if (!client) throw new Error(t("settings.vault.offlineTitle"));
      const outcome: ImportOutcome = { added: 0, failures: [] };
      for (const row of chosen) {
        try {
          await client.vaultSetSecret({
            name: secretNameFromEnvName(row.variable),
            envName: row.variable,
            description: row.candidate.label,
            source: { kind: "local" },
            value: row.candidate.value,
          });
          outcome.added += 1;
          dispatch({ type: "select", id: row.candidate.id, selected: false });
        } catch (error) {
          outcome.failures.push({ variable: row.variable, message: vaultErrorMessage(error) });
        }
      }
      return outcome;
    },
    onSuccess: (outcome) => {
      if (outcome.added > 0) {
        onAdded({ count: outcome.added, complete: outcome.failures.length === 0 });
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: vaultRoot(serverId) }),
  });
  const submit = useCallback(() => add.mutate(), [add]);
  const outcome = add.data;
  return (
    <View style={styles.list} testID="vault-import-rows">
      {rows.map(({ candidate, variable, selected, issues }) => (
        <ImportRow
          key={candidate.id}
          id={candidate.id}
          label={candidate.label}
          valueLength={candidate.value.length}
          variable={variable}
          selected={selected}
          error={selected ? issues.envName : null}
          dispatch={dispatch}
        />
      ))}
      {outcome?.failures.map((failure) => (
        <Text key={failure.variable} accessibilityRole="alert" style={settingsStyles.rowError}>
          {t("settings.vault.import.failed", { name: failure.variable, error: failure.message })}
        </Text>
      ))}
      <Button onPress={submit} disabled={!canSubmit || add.isPending} testID="vault-import-submit">
        {add.isPending
          ? t("settings.vault.working")
          : t("settings.vault.import.add", { count: chosen.length })}
      </Button>
    </View>
  );
}

interface ImportRowProps {
  id: string;
  label: string;
  valueLength: number;
  variable: string;
  selected: boolean;
  error: string | null;
  dispatch: (action: ImportAction) => void;
}

function ImportRow({
  id,
  label,
  valueLength,
  variable,
  selected,
  error,
  dispatch,
}: ImportRowProps) {
  const { t } = useTranslation();
  const select = useCallback(
    (value: boolean) => dispatch({ type: "select", id, selected: value }),
    [dispatch, id],
  );
  const rename = useCallback(
    (value: string) => dispatch({ type: "variable", id, variable: value }),
    [dispatch, id],
  );
  return (
    <View style={styles.row}>
      <Switch value={selected} onValueChange={select} accessibilityLabel={label} />
      <View style={styles.fields}>
        <Field label={label} error={error}>
          <FormTextInput
            initialValue={variable}
            onChangeText={rename}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={t("settings.vault.import.variable")}
          />
        </Field>
        <Text style={settingsStyles.rowHint}>
          {`${t("settings.vault.secrets.nameSeen", { name: secretNameFromEnvName(variable) })} · ${t("settings.vault.import.valueLength", { count: valueLength })}`}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: { gap: theme.spacing[3] },
  row: { flexDirection: "row", alignItems: "flex-start", gap: theme.spacing[3] },
  fields: { flex: 1, gap: theme.spacing[1] },
}));
