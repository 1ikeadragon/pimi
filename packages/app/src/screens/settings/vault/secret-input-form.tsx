import { useCallback, useReducer } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useTranslation } from "@/i18n/use-translation";
import { settingsStyles } from "@/styles/settings";

interface FormState {
  value: string;
  confirmation: string;
  resetKey: number;
}

type FormAction =
  | { type: "value"; value: string }
  | { type: "confirmation"; value: string }
  | { type: "clear" };

function reduce(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case "value":
      return { ...state, value: action.value };
    case "confirmation":
      return { ...state, confirmation: action.value };
    case "clear":
      return { value: "", confirmation: "", resetKey: state.resetKey + 1 };
  }
}

interface SecretInputFormProps {
  label: string;
  submitLabel: string;
  /** Asks for the value twice and submits only when both match. */
  confirmLabel?: string;
  minLength?: number;
  pending: boolean;
  error: string | null;
  onSubmit: (value: string) => void;
  testID: string;
}

/**
 * A passphrase or master password. The text leaves this component's state the moment it is
 * submitted, so a failed attempt is retyped rather than kept in memory.
 */
export function SecretInputForm({
  label,
  submitLabel,
  confirmLabel,
  minLength = 1,
  pending,
  error,
  onSubmit,
  testID,
}: SecretInputFormProps) {
  const { t } = useTranslation();
  const [state, dispatch] = useReducer(reduce, { value: "", confirmation: "", resetKey: 0 });
  const matches = confirmLabel === undefined || state.value === state.confirmation;
  const canSubmit = state.value.length >= minLength && matches && !pending;
  const changeValue = useCallback((value: string) => dispatch({ type: "value", value }), []);
  const changeConfirmation = useCallback(
    (value: string) => dispatch({ type: "confirmation", value }),
    [],
  );
  const submit = useCallback(() => {
    if (!canSubmit) return;
    onSubmit(state.value);
    dispatch({ type: "clear" });
  }, [canSubmit, onSubmit, state.value]);
  return (
    <View style={styles.form} testID={testID}>
      <Field label={label}>
        <FormTextInput
          initialValue=""
          resetKey={state.resetKey}
          onChangeText={changeValue}
          onSubmitEditing={confirmLabel === undefined ? submit : undefined}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          editable={!pending}
          accessibilityLabel={label}
          testID={`${testID}-input`}
        />
      </Field>
      {confirmLabel === undefined ? null : (
        <Field label={confirmLabel}>
          <FormTextInput
            initialValue=""
            resetKey={state.resetKey}
            onChangeText={changeConfirmation}
            onSubmitEditing={submit}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            editable={!pending}
            accessibilityLabel={confirmLabel}
            testID={`${testID}-confirm`}
          />
        </Field>
      )}
      {error ? (
        <Text accessibilityRole="alert" style={settingsStyles.rowError}>
          {error}
        </Text>
      ) : null}
      <Button onPress={submit} disabled={!canSubmit} testID={`${testID}-submit`}>
        {pending ? t("settings.vault.working") : submitLabel}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  form: {
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
}));
